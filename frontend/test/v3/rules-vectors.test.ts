/**
 * The site's mirror (lib/quote.ts) against the oracle's own round-4 rules vectors, oracle/test/fixtures/rules-v3-vectors.json
 * (written by oracle/test/fixtures/make-rules-vectors.ts with rewards.ts computeEpochV3 and asserted there byte for byte).
 * The vectors' note asks every mirror to reproduce burns[] order and the allocation fields; this test also checks the
 * chain L records (D-13, with F5's carried rule: L.next and L.nextRule; rules block 2), the capacity and its cap (D-22 a), the XNT build price and its USDC.X factor (D-22 c), the
 * orphan price (D-21), the tie-break (D-14), the backlog and operator ranks (D-12, D-18) and the rules block's dust
 * minimum, and that the live quote (quoteBurn) gives the engine's arrival outcome for every burn of the window it can
 * quote exactly (the last burn of its chain-hour: earlier burns of the same hour share the pot with later ones).
 * The file is read from the oracle tree of this checkout; the test is skipped when it is absent.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    applyBurn, arrival, capReserveOf, CLOCK_SKEW_MAX, dayCap, dayOf, decay, EPOCH_DAYS, firstLiquidityCap, FP, globalOrder, HOUR, K_BPS, lamportsOf,
    liquidityCarried, liquidityReading, liquidityRule, liquidityStatOf, medianE18, nextLiquidity, operatorOf, orphanPrice, pegged, PLAN_BPS,
    PRICE_CAP_BPS, prevLiquidityOf, quoteBurn, rankClass, recordedLiquiditySamples, RULES_ID, rulesOf, spotMicro, TIER_MULTIPLIER, trancheCap, windowLOf,
    XNT_FLOOR_BPS, xenPrice, weekStartFromFile, xntPeg, xntPrice, type LNextRule, type QuoteChainState, type QuoteWeekState,
} from '../../src/lib/quote';

const VECTORS = path.resolve(__dirname, '../../../oracle/test/fixtures/rules-v3-vectors.json');
const BPS = 10_000n;
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const readings = (m: string, l: string, src: string): [bigint, bigint] | null => (src === 'candles' ? [BigInt(m), BigInt(l)] : null);

interface Work {
    b: any; cls: 0 | 1 | 2; backlog: boolean; operator: boolean; exception: string | null;
    priceE18: bigint; priceRule: string; x: bigint; xntRule: string; hour: number; day: number; spot: bigint; value: bigint;
    base: bigint; lp: bigint; ent: bigint; band: bigint; senior: bigint; basePaid: bigint; bandPaid: bigint; lockedLp: bigint; leafTier: number; converted: boolean;
}

/** One epoch of a vector world, rebuilt with the site's functions from its inputs and the previous file. */
function replay(inputs: any, prev: any | null, file: any) {
    const rules = rulesOf(file.rulesBlock);
    expect(rules, 'the rules block is one the mirror implements').not.toBeNull();
    const minVestEnt = rules!.vestMinEnt;
    const startTs: number = inputs.window.startTs;
    const endTs: number = inputs.window.endTs;
    // D-22 (c): the USDC.X factor and the build price
    const twap = BigInt(inputs.xnt.twapE18);
    const api = BigInt(inputs.xnt.apiE18);
    const peg = xntPeg(twap, api);
    const xBuild = max(pegged(twap, peg.factorE18), api);
    const prevX = prev === null ? null : BigInt(prev.xnt.usdE18 || '0') || null;
    const xFloor = prevX === null ? 0n : (prevX * XNT_FLOOR_BPS) / BPS;
    // capacity and D-22 (a)
    const Fref = BigInt(inputs.freePool.open ?? inputs.freePool.lamports);
    const planCash = (Fref * PLAN_BPS) / BPS;
    const tc = trancheCap(capReserveOf(prev));
    const C = tc === null ? planCash : min(planCash, tc);

    const chainRec = new Map<number, any>();
    const state = new Map<number, QuoteChainState>();
    const works: Work[] = [];
    for (const c of [...inputs.chains].sort((a: any, b: any) => a.chainId - b.chainId)) {
        const pc = prev?.chains.find((x: any) => x.chainId === c.chainId);
        const orphan = c.orphan === true ? BigInt(pc.orphan.refE18) : undefined;
        const refInputs = pc ? [pc.xenUsdE18, ...pc.refInputs.slice(0, 3)].map(BigInt) : [];
        const ref = orphan ?? (medianE18(refInputs) || BigInt(c.market.refUsdE18));
        const cap = (ref * PRICE_CAP_BPS) / BPS;
        const spotE18 = BigInt(c.market.spotE18);
        // D-13: the window's L from epoch n−1's record (or the build's statistic for genesis / first)
        const Lnow = BigInt(c.liquidityNowMicro);
        const onChain = c.liquidityOnChainMicro === undefined || c.liquidityOnChainMicro === null ? null : BigInt(c.liquidityOnChainMicro);
        // r6-review 3: the statistic over the full stat days (the build's own reading only when nothing is recorded)
        const stat = liquidityStatOf(recordedLiquiditySamples(c.liquiditySamples, endTs), endTs, liquidityReading(Lnow, onChain));
        const lr = liquidityRule(prevLiquidityOf(prev, c.chainId), prev !== null, stat, firstLiquidityCap(c.poolCreatedAt ?? null, startTs));
        // F5: a window whose feed was missing or thin carries its L (the build's own reading alone never moves the next L)
        // r6-review 2: at the switch epoch (a v2 previous file) 2 full days clamp it
        const coverage = liquidityCarried(recordedLiquiditySamples(c.liquiditySamples, endTs), endTs, orphan !== undefined, prev?.version === 2);
        const nextRule: LNextRule = coverage.carried ? 'carried' : 'clamp';
        chainRec.set(c.chainId, { used: lr.used, rule: lr.rule, stat, next: coverage.carried ? lr.used : nextLiquidity(stat, lr.used), nextRule, cap: lr.cap });
        if (prev !== null) {
            // what the live site derives from the newest file alone: the same L when it is frozen, none otherwise
            const wl = windowLOf(prev, c.chainId);
            expect(wl.L, `chain ${c.chainId}: windowLOf`).toBe(lr.rule === 'frozen' || lr.rule === 'switch' ? lr.used : null);
        }
        const burns = [...c.burns].sort(globalOrder);
        const backlogChain = prev !== null && (pc === undefined || pc.skipped === true);
        state.set(c.chainId, {
            chainId: c.chainId, Lprev: null, Lnow, S: pc ? BigInt(pc.curveAfter.S) : 0n, hour: pc ? pc.curveAfter.hour : burns.length ? Math.floor(burns[0].timestamp / HOUR) : 0,
            hourSpot: 0n, capE18: cap, spotE18, Lwindow: lr.used, Lrule: lr.rule, ...(orphan !== undefined ? { orphanRefE18: orphan } : {}),
        });
        for (const b of burns) {
            const xen = orphan !== undefined ? { priceE18: orphanPrice(orphan), rule: 'orphan' } : xenPrice(readings(b.medianE18, b.lastCloseE18, b.priceSource), spotE18, cap);
            const xr = readings(b.xntMedianE18, b.xntLastCloseE18, b.xntSource);
            const xnt = xntPrice(xr === null ? null : [pegged(xr[0], peg.factorE18), pegged(xr[1], peg.factorE18)], xBuild, xFloor);
            const op = operatorOf(rules!.operatorWallets, b.x1, b.timestamp);
            const backlog = backlogChain && b.timestamp < startTs;
            works.push({
                b, cls: rankClass({ backlog, operator: op.operator }), backlog, operator: op.operator, exception: op.exception,
                priceE18: xen.priceE18, priceRule: xen.rule, x: xnt.xE18, xntRule: xnt.rule, hour: Math.floor(b.timestamp / HOUR), day: dayOf(b.timestamp, startTs),
                spot: spotMicro(BigInt(b.amountWei), xen.priceE18), value: 0n, base: 0n, lp: 0n, ent: 0n, band: 0n, senior: 0n, basePaid: 0n, bandPaid: 0n, lockedLp: 0n, leafTier: 0, converted: false,
            });
        }
    }
    // runCurve, per chain in time order: a chain-hour's burns share one pot
    for (const [chainId, s0] of state) {
        const mine = works.filter((w) => w.b.chainId === chainId).sort((a, b) => globalOrder(a.b, b.b));
        let S = s0.S;
        let hour = s0.hour;
        for (let i = 0; i < mine.length; ) {
            const H = mine[i].hour;
            let j = i;
            let V = 0n;
            while (j < mine.length && mine[j].hour === H) V += mine[j++].spot;
            S = decay(S, Math.max(0, H - hour));
            const L = s0.Lwindow!;
            for (let k = i; k < j; k++) mine[k].value = L === 0n || V === 0n ? 0n : (L * L * mine[k].spot) / ((L + S) * (L + S + V));
            S += V;
            hour = Math.max(hour, H);
            i = j;
        }
    }
    // D-14 order, then the D-12 / D-18 classes (stable): the arrival order
    works.sort((a, b) => globalOrder(a.b, b.b));
    const arrivalOrder = [0, 1, 2].flatMap((k) => works.filter((w) => w.cls === k));
    const lateDay = dayOf(endTs + CLOCK_SKEW_MAX, startTs);
    for (const w of arrivalOrder) {
        if (w.cls !== 0) w.day = lateDay;
        w.base = lamportsOf(w.value, w.x);
        w.lp = (w.base * K_BPS) / BPS;
        w.ent = (w.base * K_BPS * TIER_MULTIPLIER[w.b.tier]) / BPS;
        w.band = w.ent - w.lp;
    }
    // allocateBurns with the plan: stage 1 = class 0 then 1 at the arrival, 1 then 0 in the leftover; stage 2 = class 2
    const idx = (k: number) => arrivalOrder.filter((w) => w.cls === k);
    let consumed = 0n;
    for (const stage of [{ arrival: [...idx(0), ...idx(1)], leftover: [...idx(1), ...idx(0)] }, { arrival: idx(2), leftover: idx(2) }]) {
        for (const w of stage.arrival) {
            const cap = w.day < EPOCH_DAYS ? dayCap(C, w.day) : C;
            const vests = w.b.tier > 0 && w.lp + w.band >= minVestEnt;
            const claim = min(vests ? w.lp + w.band : w.lp, max(0n, cap - consumed));
            const a = arrival(w.b.tier, w.lp, w.band, claim, minVestEnt);
            Object.assign(w, { senior: a.senior, lockedLp: a.lockedLp, bandPaid: a.bandPaid, basePaid: a.basePaid, leafTier: a.leafTier, converted: a.converted });
            consumed += a.senior;
        }
        for (const w of stage.leftover) {
            const take = min(w.lp - w.basePaid, max(0n, C - consumed));
            w.basePaid += take;
            consumed += take;
        }
    }
    return { C, planCash, tc, xBuild, xFloor, peg, arrivalOrder, chainRec, state, minVestEnt, startTs };
}

const FIELDS = (w: Work) => ({
    chainId: w.b.chainId, txHash: w.b.txHash, logIndex: w.b.logIndex, backlog: w.backlog, operator: w.operator, exception: w.exception,
    priceE18: w.priceE18.toString(), priceRule: w.priceRule, xntE18: w.x.toString(), xntRule: w.xntRule, hour: w.hour, day: w.day,
    spotMicro: w.spot.toString(), valueMicro: w.value.toString(), base: w.base.toString(), lp: w.lp.toString(), ent: w.ent.toString(), band: w.band.toString(),
    senior: w.senior.toString(), basePaid: w.basePaid.toString(), bandPaid: w.bandPaid.toString(), lockedLp: w.lockedLp.toString(), leafTier: w.leafTier, converted: w.converted,
});
const KEYS = ['chainId', 'txHash', 'logIndex', 'backlog', 'operator', 'exception', 'priceE18', 'priceRule', 'xntE18', 'xntRule', 'hour', 'day', 'spotMicro', 'valueMicro',
    'base', 'lp', 'ent', 'band', 'senior', 'basePaid', 'bandPaid', 'lockedLp', 'leafTier', 'converted'];
const FILE_FIELDS = (b: any) => Object.fromEntries(KEYS.map((k) => [k, b[k]]));

describe.skipIf(!fs.existsSync(VECTORS))('lib/quote.ts == the oracle rules vectors (rules-v3-vectors.json)', () => {
    const g = fs.existsSync(VECTORS) ? JSON.parse(fs.readFileSync(VECTORS, 'utf8')) : { worlds: [] };

    it('is the vectors file the oracle asserts', () => {
        expect(g.kind).toBe('rules-v3-vectors');
        expect(g.version).toBe(1);
        expect(g.worlds.length).toBeGreaterThan(0);
    });

    it('rebuilds every file: capacity, XNT, chain L records, burns[] order and every allocation field', () => {
        let files = 0;
        let burns = 0;
        const seen = new Set<string>();
        for (const w of g.worlds) {
            let prev: any | null = null;
            for (const e of w.epochs) {
                const f = e.file;
                const at = `${w.name} epoch ${f.epoch}`;
                expect(f.capacity.shortfall, `${at}: the mirror replays no build-limit cut`).toBeNull();
                const r = replay(e.inputs, prev, f);
                expect([r.C, r.planCash, r.tc].map((x) => (x === null ? null : x.toString())), `${at}: capacity`).toEqual([f.capacity.cash, f.capacity.planCash, f.capacity.trancheCap]);
                expect([r.xBuild.toString(), r.xFloor.toString(), r.peg.guard, r.peg.factorE18.toString()], `${at}: XNT`).toEqual([f.xnt.buildE18, f.xnt.floorE18, f.xnt.peg.guard, f.xnt.peg.factorE18]);
                for (const c of f.chains.filter((x: any) => !x.skipped)) {
                    const m = r.chainRec.get(c.chainId);
                    expect(m, `${at}: chain ${c.chainId} valued`).toBeTruthy();
                    expect([m.used.toString(), m.rule, m.stat.toString(), m.next.toString(), m.nextRule, m.cap === null ? null : m.cap.toString()], `${at}: chain ${c.chainId} L`)
                        .toEqual([c.L.used, c.L.rule, c.L.stat, c.L.next, c.L.nextRule, c.L.cap]);
                    seen.add(c.L.rule);
                    seen.add(`next-${c.L.nextRule}`);
                }
                // a skipped chain (nothing read) keeps the frozen value it had: nextRule 'carried', next = the previous next (or L)
                for (const c of f.chains.filter((x: any) => x.skipped)) {
                    const p = prevLiquidityOf(prev, c.chainId);
                    const want = p === null ? null : p.next !== undefined && p.next !== null ? p.next : p.L;
                    expect([c.L.nextRule, c.L.next], `${at}: skipped chain ${c.chainId} L`).toEqual(['carried', want === null ? null : want.toString()]);
                    seen.add('skipped-carried');
                }
                expect(f.rulesBlock.rulesId, `${at}: rulesId`).toBe(RULES_ID);
                expect(r.arrivalOrder.map(FIELDS), `${at}: burns`).toEqual(f.burns.map(FILE_FIELDS));
                for (const b of r.arrivalOrder) {
                    if (b.backlog) seen.add('backlog');
                    if (b.operator) seen.add('operator');
                    if (b.exception) seen.add('exception');
                    if (b.priceRule === 'orphan') seen.add('orphan');
                }
                if (r.tc !== null && r.tc < r.planCash) seen.add('tranche-cap');
                if (r.peg.guard === 'high') seen.add('peg-high');
                files++;
                burns += f.burns.length;
                prev = f;
            }
        }
        expect(files).toBeGreaterThan(10);
        expect(burns).toBeGreaterThan(20);
        // every round-4 and F5 rule the vectors exercise is reached by this replay
        for (const k of ['genesis', 'frozen', 'first', 'backlog', 'operator', 'exception', 'orphan', 'tranche-cap', 'peg-high', 'next-clamp', 'next-carried', 'skipped-carried']) {
            expect(seen.has(k), k).toBe(true);
        }
    });

    it('weekStartFromFile: from a published file alone, the next window\'s C (D-22 a), frozen L (D-13) and orphaning (D-21)', () => {
        let pairs = 0;
        let frozenSeen = 0;
        let unfrozenSeen = 0;
        for (const w of g.worlds) {
            for (let i = 1; i < w.epochs.length; i++) {
                const prev = w.epochs[i - 1].file;
                const { inputs, file } = w.epochs[i];
                // the publication record the oracle writes into a published file (F_ref = free_pool_before − budget)
                const published = { ...prev, publish: { tx: 'x', publishedAt: inputs.window.startTs, freePoolBefore: inputs.freePool.open, budget: '0' } };
                const Lnow = new Map<number, bigint>(inputs.chains.map((c: any) => [c.chainId, BigInt(c.liquidityNowMicro)]));
                const s = weekStartFromFile(published, Lnow, BigInt(file.xnt.buildE18), inputs.window.endTs)!;
                expect(s, `${w.name} epoch ${file.epoch}`).not.toBeNull();
                expect([s.epoch, s.startTs, s.C], `${w.name} epoch ${file.epoch}: start`).toEqual([file.epoch, inputs.window.startTs, BigInt(file.capacity.cash)]);
                for (const c of file.chains.filter((x: any) => !x.skipped)) {
                    const st = s.chains.get(c.chainId);
                    if (c.L.rule === 'frozen' || c.L.rule === 'switch') {
                        expect(st?.Lwindow, `${w.name} epoch ${file.epoch} chain ${c.chainId}`).toBe(BigInt(c.L.used));
                        frozenSeen++;
                    } else {
                        // listed as unfrozen, or (a chain the file does not carry) not in the state at all: no quote either way
                        expect(s.unfrozen!.includes(c.chainId) || !s.chains.has(c.chainId), `${w.name} epoch ${file.epoch} chain ${c.chainId} (${c.L.rule})`).toBe(true);
                        expect(quoteBurn(s, { chainId: c.chainId, amountWei: 10n ** 24n, tier: 0, timestamp: s.startTs + 60, xen: null, xnt: null }, s.asOf).ok).toBe(false);
                        unfrozenSeen++;
                    }
                    if (c.orphan && c.orphan.from <= file.epoch) expect(st?.orphanRefE18).toBe(BigInt(c.orphan.refE18));
                }
                pairs++;
            }
        }
        expect(pairs).toBeGreaterThan(10);
        expect(frozenSeen).toBeGreaterThan(10);
        expect(unfrozenSeen).toBeGreaterThan(0);
    });

    it('the live quote (quoteBurn) gives the engine\'s outcome for every window burn it can quote exactly', () => {
        let quoted = 0;
        let sameSecond = 0;
        for (const w of g.worlds) {
            let prev: any | null = null;
            for (const e of w.epochs) {
                const f = e.file;
                const r = replay(e.inputs, prev, f);
                const byTx = new Map(f.burns.map((b: any) => [`${b.chainId}:${b.txHash}:${b.logIndex}`, b]));
                let s: QuoteWeekState = {
                    epoch: f.epoch, startTs: r.startTs, C: r.C, senior: 0n, xFloorE18: r.xFloor, xBuildE18: r.xBuild, chains: new Map(r.state), asOf: 0, skipped: [],
                    ...(r.peg.factorE18 !== FP ? { xntPegE18: r.peg.factorE18 } : {}), vestMinEnt: r.minVestEnt,
                };
                const timeOrder = [...r.arrivalOrder].sort((a, b) => globalOrder(a.b, b.b));
                timeOrder.forEach((wk, i) => {
                    const eng: any = byTx.get(`${wk.b.chainId}:${wk.b.txHash}:${wk.b.logIndex}`);
                    const lastOfHour = !timeOrder.slice(i + 1).some((o) => o.b.chainId === wk.b.chainId && o.hour === wk.hour);
                    const input = {
                        chainId: wk.b.chainId, amountWei: BigInt(wk.b.amountWei), tier: wk.b.tier, timestamp: wk.b.timestamp,
                        xen: wk.b.priceSource === 'orphan' ? null : readings(wk.b.medianE18, wk.b.lastCloseE18, wk.b.priceSource), xnt: readings(wk.b.xntMedianE18, wk.b.xntLastCloseE18, wk.b.xntSource),
                    };
                    if (wk.cls === 0 && lastOfHour) {
                        const q = quoteBurn({ ...s, asOf: wk.b.timestamp }, input, wk.b.timestamp);
                        expect(q.ok, q.ok ? '' : (q as any).reason).toBe(true);
                        if (q.ok) {
                            expect([q.priceE18, q.xE18, q.value, q.lp, q.band, q.basePaid + q.bandPaid, q.bandPaid, q.lockedLp, q.leafTier, q.converted, q.day].map(String), `${w.name} ${wk.b.txHash}`)
                                .toEqual([eng.priceE18, eng.xntE18, eng.valueMicro, eng.lp, eng.band, eng.senior, eng.bandPaid, eng.lockedLp, eng.leafTier, eng.converted, eng.day].map(String));
                            quoted++;
                        }
                    } else if (wk.cls === 0) sameSecond++;
                    // book the burn as the build does: its spot in its chain's curve; its arrival claim only for a burn of the window
                    s = applyBurn(s, input, { spot: wk.spot, basePaid: wk.cls === 0 ? BigInt(eng.senior) : 0n, bandPaid: 0n } as any);
                });
                prev = f;
            }
        }
        expect(quoted).toBeGreaterThan(15);
        expect(sameSecond).toBeGreaterThan(0);
    });
});
