/**
 * The site side of the week-so-far feed v1 (the FEED CONTRACT of agents/kit/burn.mjs; kit review K-01): the site's
 * parser (lib/quote.ts weekStateFromFeed) and its live quote (quoteFromWeek → quoteBurn, what QuotePanel runs) on the
 * kit's example feed agents/kit/test/vectors/week-so-far.v1.json. The oracle's hourly writer rebuilds that file to the
 * byte (oracle/test/feed.test.ts), so the three clients read one schema. The site must give the kit's own numbers for
 * the fixture's candidate burn, keep reading the feed when a chain is skipped, and refuse a feed whose duplicated fields
 * disagree. With the kit's dependencies installed (agents/kit/node_modules), a sweep of burns on every chain, tier and
 * size is also checked against the kit's quoteBurn.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROGRAM_ID_B58 } from '../../src/lib/constants';
import { HOUR, PRICE_RULES, quoteFromWeek, weekStateFromFeed, type QuoteOk, type WeekSoFarFeed } from '../../src/lib/quote';

const REPO = path.resolve(__dirname, '../../..');
const KIT = path.join(REPO, 'agents', 'kit');
const FIXTURE = path.join(KIT, 'test', 'vectors', 'week-so-far.v1.json');
const EPOCH1 = path.join(REPO, 'frontend', 'public', 'epochs', 'epoch-1.json');
const kitReady = ['@noble/hashes', '@solana/web3.js', 'bs58'].every((m) => fs.existsSync(path.join(KIT, 'node_modules', m)));

const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const newestOf = (f: any) => ({ epoch: f.prevEpoch.epoch, dataHash: f.prevEpoch.dataHash });
const stateOf = (f: any) => weekStateFromFeed(f as WeekSoFarFeed, newestOf(fx.feed), PROGRAM_ID_B58);
const quote = (f: any, c: { chainId: number; amountWei: bigint; tier: number }, now: number) => quoteFromWeek(stateOf(f), f.readings, c, now);
const cand = { chainId: fx.candidate.chainId as number, amountWei: BigInt(fx.candidate.amountWei), tier: fx.candidate.tier as number };
const NOW = fx.candidate.now as number;

/** The supersetFeed shape of a chain the build skips: it stays in chains[] without derived fields, and skipped[] lists it. */
function skip(f: any, chainId: number) {
    const g = clone(f);
    g.chains = g.chains.map((c: any) => (c.chainId === chainId ? { chainId: c.chainId, name: c.name, portal: c.portal, status: 'skipped' } : c));
    g.skipped = [...g.skipped, chainId];
    delete g.readings.xen[String(chainId)];
    return g;
}

describe('week-so-far feed v1: the kit fixture, quoted by the site', () => {
    it('is the contract the site reads (v1, rules 3, this program, continues epoch − 1)', () => {
        expect(fx.feed.kind).toBe('week-so-far');
        expect(fx.feed.version).toBe(1);
        expect(fx.feed.rules).toBe(3);
        expect(fx.feed.programId).toBe(PROGRAM_ID_B58);
        expect(fx.feed.prevDataHash).toBe(fx.feed.prevEpoch.dataHash);
        expect(fx.feed.epoch).toBe(fx.feed.prevEpoch.epoch + 1);
        // the fixture continues the real epoch-1 file the site serves
        const e1 = JSON.parse(fs.readFileSync(EPOCH1, 'utf8'));
        expect({ epoch: e1.epoch, dataHash: e1.dataHash }).toEqual(newestOf(fx.feed));
    });

    it('parses into the week state of its derived fields', () => {
        const w = stateOf(fx.feed)!;
        expect(w).not.toBeNull();
        expect(w.epoch).toBe(fx.feed.epoch);
        expect(w.startTs).toBe(fx.feed.window.startTs);
        expect(w.asOf).toBe(fx.feed.asOf);
        expect(w.C).toBe(BigInt(fx.feed.capacity.cash));
        expect(w.senior).toBe(BigInt(fx.feed.capacity.senior));
        expect(w.xBuildE18).toBe(BigInt(fx.feed.xnt.buildE18));
        expect(w.xFloorE18).toBe(BigInt(fx.feed.xnt.floorE18));
        expect(w.skipped).toEqual([]);
        expect(w.held).toEqual([]);
        expect([...w.chains.keys()].sort((a, b) => a - b)).toEqual(fx.feed.chains.map((c: any) => c.chainId).sort((a: number, b: number) => a - b));
        for (const c of fx.feed.chains) {
            const s = w.chains.get(c.chainId)!;
            expect([s.Lnow, s.Lprev, s.S, s.hour, s.hourSpot, s.capE18, s.spotE18]).toEqual([
                BigInt(c.Lnow), c.Lprev === null ? null : BigInt(c.Lprev), BigInt(c.S), c.hour, BigInt(c.hourSpot), BigInt(c.capE18), BigInt(c.spotE18),
            ]);
        }
    });

    it('gives the kit\'s binding number, entitlement, day and room for the fixture\'s candidate', () => {
        expect(Math.floor(NOW / HOUR)).toBe(fx.expected.hour);
        expect(fx.feed.readings.hour).toBe(fx.expected.hour);
        const q = quote(fx.feed, cand, NOW);
        expect(q.ok, q.ok ? '' : (q as any).reason).toBe(true);
        const r = q as QuoteOk;
        expect(r.paidAtArrival.toString()).toBe(fx.expected.bindingNow);
        expect(r.entitlement.toString()).toBe(fx.expected.entitlement);
        expect(r.day).toBe(fx.expected.day);
        expect(r.roomToday.toString()).toBe(fx.expected.remainingToday);
        expect(r.fitsWhole).toBe(fx.expected.bindingNow === fx.expected.entitlement);
    });

    it('keeps reading the feed when a chain is skipped, and never quotes that chain', () => {
        const g = skip(fx.feed, 56);
        const w = stateOf(g);
        expect(w).not.toBeNull();
        expect(w!.skipped).toEqual([56]);
        expect(w!.chains.has(56)).toBe(false);
        const q = quote(g, cand, NOW) as QuoteOk;
        expect(q.ok).toBe(true);
        expect(q.paidAtArrival.toString()).toBe(fx.expected.bindingNow);
        const s = quote(g, { ...cand, chainId: 56 }, NOW);
        expect(s.ok).toBe(false);
        expect((s as any).reason).toMatch(/skipped/);
        // listed only in skipped[] (no chains[] entry): still skipped
        const h = clone(g);
        h.chains = h.chains.filter((c: any) => c.chainId !== 56);
        expect(stateOf(h)!.skipped).toEqual([56]);
        expect(quote(h, { ...cand, chainId: 56 }, NOW).ok).toBe(false);
    });

    it('never quotes a quarantined or sunset chain, but keeps the rest of the feed', () => {
        for (const status of ['quarantined', 'sunset']) {
            const g = clone(fx.feed);
            g.chains.find((c: any) => c.chainId === 10).status = status;
            expect(stateOf(g)!.held).toEqual([10]);
            expect(quote(g, { ...cand, chainId: 10 }, NOW).ok).toBe(false);
            expect((quote(g, cand, NOW) as QuoteOk).paidAtArrival.toString()).toBe(fx.expected.bindingNow);
        }
    });

    it('refuses a feed whose twin fields disagree, or that is not v1 for this program under rules 3', () => {
        const bad: [string, (g: any) => void][] = [
            ['rules 2', (g) => { g.rules = 2; }],
            ['no rules', (g) => { delete g.rules; }],
            ['another program', (g) => { g.programId = '11111111111111111111111111111111'; }],
            ['version 2', (g) => { g.version = 2; }],
            ['prevEpoch vs prevDataHash', (g) => { g.prevEpoch.dataHash = '00'.repeat(32); }],
            ['prevEpoch not epoch − 1', (g) => { g.prevEpoch.epoch = g.epoch - 2; }],
            ['skipped[] lists an ok chain', (g) => { g.skipped = [10]; }],
            ['skipped chain missing from skipped[]', (g) => { g.chains[1] = { chainId: g.chains[1].chainId, status: 'skipped' }; }],
            ['unknown status', (g) => { g.chains[0].status = 'paused'; }],
            ['Lnow vs liquidityNowMicro', (g) => { g.chains[0].Lnow = String(BigInt(g.chains[0].Lnow) + 1n); }],
            ['readings vs current (xen)', (g) => { g.readings.xen['10'] = ['1', '2']; }],
            ['readings vs current (hour)', (g) => { g.readings.hour += 1; }],
            ['readings vs current (xnt)', (g) => { g.readings.xnt = null; }],
            ['a derived field missing', (g) => { delete g.chains[0].S; }],
            ['a non-canonical integer', (g) => { g.capacity.senior = '0x10'; }],
            ['senior above the capacity', (g) => { g.capacity.senior = String(BigInt(g.capacity.cash) + 1n); }],
            ['duplicate chain', (g) => { g.chains.push(clone(g.chains[0])); }],
        ];
        for (const [what, edit] of bad) {
            const g = clone(fx.feed);
            edit(g);
            expect(stateOf(g), what).toBeNull();
        }
        // a feed that does not continue the newest epoch file the site holds
        expect(weekStateFromFeed(fx.feed, { epoch: fx.feed.prevEpoch.epoch, dataHash: 'ff'.repeat(32) }, PROGRAM_ID_B58)).toBeNull();
        expect(weekStateFromFeed(fx.feed, { epoch: fx.feed.prevEpoch.epoch - 1, dataHash: fx.feed.prevDataHash }, PROGRAM_ID_B58)).toBeNull();
        expect(weekStateFromFeed(fx.feed, null, PROGRAM_ID_B58)).toBeNull();
    });

    it('refuses the live quote off this hour, with the clock behind the feed, near the hour\'s end, or without the chain\'s reading', () => {
        const hourEnd = (Math.floor(NOW / HOUR) + 1) * HOUR;
        expect(quote(fx.feed, cand, hourEnd + 60).ok).toBe(false); // the readings are for the previous hour
        expect(quote(fx.feed, cand, fx.feed.asOf - 1).ok).toBe(false); // clock behind the feed
        expect(quote(fx.feed, cand, hourEnd - 179).ok).toBe(false); // within 180 s of the hour's end
        expect(quote(fx.feed, cand, hourEnd - 180).ok).toBe(true);
        expect(quote(fx.feed, cand, fx.feed.asOf + 2 * HOUR + 1).ok).toBe(false); // stale
        const g = clone(fx.feed);
        delete g.readings.xen[String(cand.chainId)];
        expect(quote(g, cand, NOW).ok).toBe(false);
        const h = clone(fx.feed);
        delete h.readings;
        expect(quote(h, cand, NOW).ok).toBe(false);
    });
});

/** The newest epoch file the fixture continues: the live epoch-1.json (a v2 file, so the fixture's week is the switch window). */
const E1 = JSON.parse(fs.readFileSync(EPOCH1, 'utf8'));
const stateD13 = (f: any, file: any = E1) => weekStateFromFeed(f as WeekSoFarFeed, newestOf(f), PROGRAM_ID_B58, file);
const quoteD13 = (f: any, c: { chainId: number; amountWei: bigint; tier: number; x1?: string }, now: number, file: any = E1) => quoteFromWeek(stateD13(f, file), f.readings, c, now);

describe('week-so-far feed v1 with the newest file: the round-4 rules (D-13, D-22 c, D-18, rules block)', () => {
    it('D-13 at the switch: every valued chain is valued at the v2 file\'s own reading, from the first hour (binding)', () => {
        const w = stateD13(fx.feed)!;
        expect(w).not.toBeNull();
        expect(w.unfrozen).toEqual([]);
        for (const c of E1.chains) {
            const s = w.chains.get(c.chainId)!;
            expect([s.Lwindow, s.Lrule], `chain ${c.chainId}`).toEqual([BigInt(c.liquidityUsdMicro), 'switch']);
        }
        const q = quoteD13(fx.feed, cand, NOW);
        expect(q.ok, q.ok ? '' : (q as any).reason).toBe(true);
        expect((q as QuoteOk).Lrule).toBe('switch');
        expect((q as QuoteOk).L).toBe(BigInt(E1.chains.find((c: any) => c.chainId === cand.chainId).liquidityUsdMicro));
        // r6-review 2: the switch L is the median of the feed's switchRefs liquidity history (here the one v2 file's
        // reading); a feed without that history gives no binding L at the switch (every chain unfrozen)
        expect(fx.feed.switchRefs.every((r: any) => Array.isArray(r.liquidity) && r.liquidity.length === r.readings.length)).toBe(true);
        const bare = { ...fx.feed, switchRefs: fx.feed.switchRefs.map((r: any) => ({ chainId: r.chainId, readings: r.readings })) };
        const wb = stateD13(bare)!;
        expect([...wb.unfrozen!].sort((x, y) => x - y)).toEqual(E1.chains.map((c: any) => c.chainId).sort((x: number, y: number) => x - y));
        // a longer history: the median of [own, $0.000001, 3 × own] is the file's own reading
        const hist = { ...fx.feed, switchRefs: fx.feed.switchRefs.map((r: any) => ({ ...r, readings: [...r.readings, r.readings[0], r.readings[0]], liquidity: [r.liquidity[0], '1', String(BigInt(r.liquidity[0]) * 3n)] })) };
        const wh = stateD13(hist)!;
        for (const c of E1.chains) expect(wh.chains.get(c.chainId)!.Lwindow, `chain ${c.chainId}`).toBe(BigInt(c.liquidityUsdMicro));
        const low = { ...fx.feed, switchRefs: fx.feed.switchRefs.map((r: any) => ({ ...r, readings: [...r.readings, r.readings[0], r.readings[0]], liquidity: [r.liquidity[0], '1', '2'] })) };
        const wl = stateD13(low)!;
        for (const c of E1.chains) expect(wl.chains.get(c.chainId)!.Lwindow, `chain ${c.chainId}`).toBe(2n);
    });

    it('D-13 after a v3 file: L.next is the frozen L; a record without one (legacy, or a new chain) gets no quote', () => {
        // a v3 "newest file" as windowLOf reads it: the feed's Lprev is its own L.used (the twin), L.next the frozen L
        const v3 = (next: (c: any) => object) => ({
            version: 3, epoch: E1.epoch, dataHash: E1.dataHash,
            chains: fx.feed.chains.map((c: any) => ({ chainId: c.chainId, L: { used: c.Lprev, ...next(c) } })),
        });
        const frozen = v3((c) => ({ next: String(BigInt(c.Lprev) * 2n) }));
        const w = stateD13(fx.feed, frozen)!;
        for (const c of fx.feed.chains) expect([w.chains.get(c.chainId)!.Lwindow, w.chains.get(c.chainId)!.Lrule]).toEqual([BigInt(c.Lprev) * 2n, 'frozen']);
        expect((quoteD13(fx.feed, cand, NOW, frozen) as QuoteOk).L).toBe(BigInt(fx.feed.chains.find((c: any) => c.chainId === cand.chainId).Lprev) * 2n);
        // no `next` member: the legacy rule needs the build's statistic → no binding quote on that chain, the others still quote
        const legacy = v3((c) => (c.chainId === cand.chainId ? {} : { next: c.Lprev }));
        expect(stateD13(fx.feed, legacy)!.unfrozen).toEqual([cand.chainId]);
        const r = quoteD13(fx.feed, cand, NOW, legacy);
        expect(r.ok).toBe(false);
        expect((r as any).reason).toMatch(/set only at the weekly build/);
        const other = fx.feed.chains.find((c: any) => c.chainId !== cand.chainId && c.current).chainId;
        expect(quoteD13(fx.feed, { ...cand, chainId: other }, NOW, legacy).ok).toBe(true);
        // a chain the newest file does not list ('first'): its Lprev must be null in the feed, and it is not quoted
        const g = clone(fx.feed);
        g.chains.find((c: any) => c.chainId === cand.chainId).Lprev = null;
        const first = { ...frozen, chains: frozen.chains.filter((c: any) => c.chainId !== cand.chainId) };
        expect(stateD13(g, first)!.unfrozen).toEqual([cand.chainId]);
    });

    it('refuses a newest file that is not the one the feed continues, or whose L the feed misstates', () => {
        expect(stateD13(fx.feed, { ...E1, dataHash: 'ff'.repeat(32) })).toBeNull();
        expect(stateD13(fx.feed, null)).toBeNull();
        const g = clone(fx.feed);
        g.chains[0].Lprev = String(BigInt(g.chains[0].Lprev) + 1n);
        expect(stateD13(g)).toBeNull();
        expect(stateD13(fx.feed)).not.toBeNull();
    });

    it('D-22 (c): a USDC.X premium above 3% raises the XNT readings; buildE18 must be its twin', () => {
        const g = clone(fx.feed);
        g.xnt.apiE18 = String((BigInt(g.xnt.twapE18) * 105n) / 100n);
        expect(stateD13(g)).toBeNull(); // buildE18 no longer max(pegged TWAP, api)
        const FP18 = 10n ** 18n;
        const factor = (BigInt(g.xnt.apiE18) * FP18) / BigInt(g.xnt.twapE18);
        const peggedTwap = (BigInt(g.xnt.twapE18) * factor) / FP18;
        g.xnt.buildE18 = String(peggedTwap > BigInt(g.xnt.apiE18) ? peggedTwap : BigInt(g.xnt.apiE18));
        const w = stateD13(g)!;
        expect(w.xntPegE18).toBe(factor);
        const plain = quoteD13(fx.feed, cand, NOW) as QuoteOk;
        const peg = quoteFromWeek(w, g.readings, cand, NOW) as QuoteOk;
        expect(['median', 'last']).toContain(plain.xntRule);
        expect(peg.xE18).toBe((plain.xE18 * factor) / FP18);
        expect(peg.base < plain.base).toBe(true);
        const n = clone(fx.feed);
        delete n.xnt.twapE18;
        expect(stateD13(n)).toBeNull();
    });

    it('D-18 and the rules block: an operator wallet gets no binding quote; inside a dated exception it is an ordinary burn', () => {
        const block = (ow: object) => ({
            programRules: 3, programHash: null, rulesId: 2, tipMin: '200000000', autoClaimMin: '0', dustRule: { vestMinEnt: '20000000' },
            tieBreak: 'keccak256(txHash,logIndex)', backlogRule: 'after-current-senior,first-leftover', operatorWallets: { rule: 'rank-last', ...ow }, priceRules: JSON.parse(JSON.stringify(PRICE_RULES)), // r4-fix: rulesOf refuses any other price rules
        });
        const x1 = fx.candidate.x1 as string;
        const g = clone(fx.feed);
        g.rulesBlock = block({ wallets: [x1], exceptions: [] });
        const r = quoteD13(g, { ...cand, x1 }, NOW);
        expect(r.ok).toBe(false);
        expect((r as any).reason).toMatch(/operator wallet/);
        expect(quoteD13(g, { ...cand, x1: '11111111111111111111111111111112' }, NOW).ok).toBe(true);
        g.rulesBlock = block({ wallets: [], exceptions: [{ name: 'proof burns', wallets: [x1], fromTs: NOW - 10, untilTs: NOW + 10, published: '2026-11-01' }] });
        expect(quoteD13(g, { ...cand, x1 }, NOW).ok).toBe(true);
        expect(quoteD13(g, { ...cand, x1 }, NOW + 20).ok).toBe(false); // outside its range the wallet ranks last again
        // a block this mirror does not implement is refused (fail-closed)
        g.rulesBlock = { ...block({ wallets: [], exceptions: [] }), tieBreak: 'chainId' };
        expect(stateD13(g)).toBeNull();
        // F5: the round-4 block (rulesId 1, replaced before any v3 epoch) is refused: no quote at all from such a feed
        g.rulesBlock = { ...block({ wallets: [], exceptions: [] }), rulesId: 1 };
        expect(stateD13(g)).toBeNull();
        expect(quoteD13(g, cand, NOW).ok).toBe(false);
        g.rulesBlock = block({ wallets: [], exceptions: [] });
        expect(stateD13(g)!.rulesId).toBe(2);
        // the dust minimum is read from the block
        g.rulesBlock = { ...block({ wallets: [], exceptions: [] }), dustRule: { vestMinEnt: '1' } };
        expect(stateD13(g)!.vestMinEnt).toBe(1n);
    });
});

const ORACLE = path.join(REPO, 'oracle');
const oracleReady = fs.existsSync(path.join(ORACLE, 'node_modules', '@solana', 'web3.js')) && fs.existsSync(path.join(ORACLE, 'src', 'feed-v3.ts'));

describe.skipIf(!oracleReady)('week-so-far feed v1: the site\'s live quote == the oracle engine on the same window', () => {
    it('the engine\'s feed of the fixture window, then the candidate burns: same value and arrival outcome', async () => {
        const F: any = await import('../../../oracle/src/feed-v3');
        const R: any = await import('../../../oracle/src/rewards');
        const raw = F.rawOfFeedV1(fx.feed);
        // the feed as the hourly writer derives it today (the kit fixture's derived fields predate D-13)
        const feed = F.weekSoFarFeedV1(raw, E1);
        const w = stateD13(feed);
        expect(w, 'the engine\'s feed parses with the newest file').not.toBeNull();
        const H = Math.floor(NOW / HOUR);
        let exact = 0;
        let bounded = 0;
        let partial = 0;
        for (const c of raw.chains.filter((x: any) => x.status !== 'skipped' && x.current)) {
            const fc = feed.chains.find((x: any) => x.chainId === c.chainId);
            const sameHour = fc.hour === H && BigInt(fc.hourSpot) > 0n;
            for (const tier of [0, 1, 2]) {
                for (const e of [20n, 24n, 26n, 27n, 28n]) {
                    const amountWei = 10n ** e * 3n;
                    const s = quoteFromWeek(w, feed.readings, { chainId: c.chainId, amountWei, tier }, NOW);
                    const label = `chain ${c.chainId} tier ${tier} 3e${e} wei`;
                    expect(s.ok, `${label}: ${s.ok ? '' : (s as any).reason}`).toBe(true);
                    const q = s as QuoteOk;
                    // the burn as the build would read it if it landed now
                    const g = clone(raw);
                    g.asOf = NOW;
                    const gc = g.chains.find((x: any) => x.chainId === c.chainId);
                    const tx = `0x${'cd'.repeat(31)}${(tier * 16 + Number(e)).toString(16).padStart(2, '0')}`;
                    const from = E1.chains.find((x: any) => x.chainId === c.chainId)?.toBlock ?? 0;
                    gc.burns.push({
                        chainId: c.chainId, txHash: tx, logIndex: 0, blockNumber: Math.max(from, ...gc.burns.map((b: any) => b.blockNumber)) + 1, missionId: '999999',
                        pilot: '0x' + '22'.repeat(20), amountWei: amountWei.toString(), tier, x1: fx.candidate.x1, timestamp: NOW,
                        medianE18: c.current.priceSource === 'candles' ? c.current.medianE18 : '0', lastCloseE18: c.current.priceSource === 'candles' ? c.current.lastCloseE18 : '0', priceSource: c.current.priceSource,
                        xntMedianE18: raw.xnt.current?.source === 'candles' ? raw.xnt.current.medianE18 : '0', xntLastCloseE18: raw.xnt.current?.source === 'candles' ? raw.xnt.current.lastCloseE18 : '0',
                        xntSource: raw.xnt.current?.source ?? 'fallback',
                    });
                    const st = R.windowStateV3(F.feedInputsV3(g, E1), E1, { limit: false, provisional: F.FEED_PROVISIONAL });
                    const wk = st.works.find((x: any) => x.b.txHash === tx);
                    const rec = st.chains.find((x: any) => x.chainId === c.chainId);
                    expect([q.value, q.base, q.lp, q.band, q.L, q.Lrule, q.day], label).toEqual([wk.value, wk.base, wk.lp, wk.band, BigInt(rec.L.used), rec.L.rule, wk.day]);
                    if (!sameHour) {
                        expect([q.paidAtArrival, q.bandPaid, q.lockedLp, q.leafTier, q.converted], label).toEqual([wk.senior, wk.bandPaid, wk.lockedLp, wk.leafTier, wk.converted]);
                        exact++;
                    } else {
                        // earlier burns of the same hour share the pot with this one, so the build pays them less and this burn at least the quote
                        expect(wk.senior >= q.paidAtArrival, label).toBe(true);
                        bounded++;
                    }
                    if (!q.fitsWhole && q.paidAtArrival > 0n) partial++;
                }
            }
        }
        expect(exact + bounded).toBeGreaterThan(30);
        expect(exact).toBeGreaterThan(0);
        expect(partial).toBeGreaterThan(0);
    }, 180_000);
});

describe.skipIf(!kitReady)('week-so-far feed v1: the site and the kit quote the same burns', () => {
    it('agrees with the kit\'s quoteBurn on every chain, tier and size of the fixture\'s hour', async () => {
        const kit: any = await import(/* @vite-ignore */ pathToFileURL(path.join(KIT, 'burn.mjs')).href);
        const kitQuote: any = await import(/* @vite-ignore */ pathToFileURL(path.join(KIT, 'quote-v3.mjs')).href);
        // D-13: until the kit mirrors liquidityRuleV3 its L is the pre-D-13 estimate, so the comparison runs on the site's
        // estimate path (no newest file); once the kit exports it, the site's binding path (with the newest file)
        const kitD13 = typeof kitQuote.liquidityRuleV3 === 'function';
        if (!kitD13) console.warn('MIRROR PENDING: agents/kit/quote-v3.mjs has no liquidityRuleV3 (D-13); site vs kit compared on the pre-D-13 estimate path');
        const siteQuote = (f: any, c: { chainId: number; amountWei: bigint; tier: number }, now: number) => (kitD13 ? quoteD13(f, c, now) : quote(f, c, now));
        const prev = JSON.parse(fs.readFileSync(EPOCH1, 'utf8'));
        const opts = { allowBelowMarket: true, allowVesting: true, allowBeyondCapacity: true, allowLargeShare: true, allowHourEdge: true, allowStaleOracle: true };
        let compared = 0;
        let partial = 0;
        for (const c of fx.feed.chains) {
            for (const tier of [0, 1, 2]) {
                for (const e of [20n, 24n, 26n, 27n, 28n, 29n]) {
                    const amountWei = 10n ** e * 3n;
                    const k = kit.quoteBurn({ feed: fx.feed, prev, chainId: c.chainId, amountWei, tier, x1: fx.candidate.x1, now: NOW, ...opts });
                    const s = siteQuote(fx.feed, { chainId: c.chainId, amountWei, tier }, NOW);
                    const label = `chain ${c.chainId} tier ${tier} 3e${e} wei`;
                    if (k.bindingNow === undefined) {
                        expect(s.ok, `${label}: the kit gives no quote (${JSON.stringify(k.refusals)})`).toBe(false);
                        continue;
                    }
                    expect(s.ok, `${label}: ${s.ok ? '' : (s as any).reason}`).toBe(true);
                    const r = s as QuoteOk;
                    expect([r.paidAtArrival, r.entitlement, r.day, r.roomToday, r.lockedLp, r.bandPaid, r.leafTier, r.converted], label).toEqual([
                        k.bindingNow, k.entitlement, k.tranche.day, k.tranche.remainingToday,
                        k.mission?.lockedLp ?? 0n, k.mission?.bandLocked ?? 0n, k.mission?.leafTier ?? 0, k.mission?.converted ?? false,
                    ]);
                    compared++;
                    if (!r.fitsWhole && r.paidAtArrival > 0n) partial++;
                }
            }
        }
        // the sweep reaches past today's room, so the partial-lock path is compared too
        expect(compared).toBeGreaterThan(50);
        expect(partial).toBeGreaterThan(0);
    }, 180_000);
});
