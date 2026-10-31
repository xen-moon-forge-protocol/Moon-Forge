/** PX pricing, the two-pot forge split and the market split: the vectors of the program's own unit tests
 *  (artifacts.rs price_tests / split_and_attribute_tests, utils.rs market_split_vector_and_sum). */
import { describe, expect, it } from 'vitest';
import { currentPrice, forgeSplit, minPrice, nextDecayIn, nextPrice } from '../../src/v3/px';
import { marketSplit, minListPriceForFloor } from '../../src/v3/market';
import { ARTIFACT_PRICE, ARTIFACT_SUPPLY, MAX_PRICE_MULTIPLE, PRICE_DECAY_PERIOD, PRICE_LAUNCH_TS, XNT } from '../../src/v3/constants';

const DAY = 86_400;
const FAR = Number.MAX_SAFE_INTEGER;
const cfg = () => ({ artifactPrice: [0n, 0n, 0n, 0n], artifactPriceTs: [0n, 0n, 0n, 0n], artifactsAlive: [0, 0, 0, 0] });

describe('PX current_price / next_price (artifacts.rs vectors)', () => {
    it('never-forged tiers decay from PRICE_LAUNCH_TS down to their minimum', () => {
        const c = cfg();
        expect(currentPrice(c, 0, PRICE_LAUNCH_TS)).toBe(10n * XNT);
        expect(currentPrice(c, 0, PRICE_LAUNCH_TS + DAY - 1)).toBe(10n * XNT);
        expect(currentPrice(c, 0, PRICE_LAUNCH_TS + DAY)).toBe(9_803_921_568n);
        expect(currentPrice(c, 0, PRICE_LAUNCH_TS + 177 * DAY)).toBe(3n * XNT);
        expect(currentPrice(c, 0, FAR)).toBe(3n * XNT);
        expect(currentPrice(c, 1, PRICE_LAUNCH_TS + 3 * DAY)).toBe((25n * XNT * 20n) / 21n);
        expect(currentPrice(c, 1, FAR)).toBe(12_500_000_000n);
        expect(currentPrice(c, 2, FAR)).toBe(30n * XNT);
        expect(currentPrice(c, 3, FAR)).toBe(100n * XNT);
        // before the launch a never-forged tier sits at base
        expect(currentPrice(c, 3, PRICE_LAUNCH_TS - 10 * DAY)).toBe(200n * XNT);
    });
    it('Cosmic rises 5% per forge and decays per three days', () => {
        const c = cfg();
        const t = 1;
        let now = PRICE_LAUNCH_TS;
        let p = currentPrice(c, t, now);
        expect(p).toBe(25n * XNT);
        for (let i = 0; i < 2; i++) {
            c.artifactPrice[t] = nextPrice(p, t);
            c.artifactPriceTs[t] = BigInt(now);
            p = currentPrice(c, t, now);
        }
        expect(p).toBe(27_562_500_000n);
        now += PRICE_DECAY_PERIOD[t] - 1;
        expect(currentPrice(c, t, now)).toBe(p);
        now += 1;
        expect(currentPrice(c, t, now)).toBe(26_250_000_000n);
        now += PRICE_DECAY_PERIOD[t];
        expect(currentPrice(c, t, now)).toBe(25n * XNT);
        now += PRICE_DECAY_PERIOD[t];
        expect(currentPrice(c, t, now)).toBe((25n * XNT * 20n) / 21n);
        now += 100 * PRICE_DECAY_PERIOD[t];
        expect(currentPrice(c, t, now)).toBe(12_500_000_000n);
    });
    it('a full tier never decays; a full never-forged tier reads base', () => {
        for (let t = 0; t < 4; t++) {
            const c = cfg();
            c.artifactPrice[t] = 3n * ARTIFACT_PRICE[t];
            c.artifactsAlive[t] = ARTIFACT_SUPPLY[t];
            expect(currentPrice(c, t, FAR)).toBe(3n * ARTIFACT_PRICE[t]);
            expect(nextDecayIn(c, t, 0)).toBeNull();
            c.artifactsAlive[t] = ARTIFACT_SUPPLY[t] - 1;
            expect(currentPrice(c, t, FAR) < 3n * ARTIFACT_PRICE[t]).toBe(true);
            const d = cfg();
            d.artifactsAlive[t] = ARTIFACT_SUPPLY[t];
            expect(currentPrice(d, t, FAR)).toBe(ARTIFACT_PRICE[t]);
        }
    });
    it('next_price caps at 10× base; the walk from 10× reaches the minimum', () => {
        for (let t = 0; t < 4; t++) {
            let p = ARTIFACT_PRICE[t];
            for (let i = 0; i < 10_000; i++) p = nextPrice(p, t);
            expect(p).toBe(ARTIFACT_PRICE[t] * MAX_PRICE_MULTIPLE);
            const c = cfg();
            c.artifactPrice[t] = p;
            expect(currentPrice(c, t, 0)).toBe(p);
            expect(currentPrice(c, t, FAR)).toBe(minPrice(t));
        }
        expect(nextPrice(10n * XNT, 0)).toBe(10_200_000_000n);
        expect(nextPrice(25n * XNT, 1)).toBe(26_250_000_000n);
    });
    it('next decay countdown', () => {
        const c = cfg();
        expect(nextDecayIn(c, 0, PRICE_LAUNCH_TS)).toBe(DAY);
        expect(nextDecayIn(c, 0, PRICE_LAUNCH_TS + 100)).toBe(DAY - 100);
        expect(nextDecayIn(c, 0, FAR)).toBeNull();
    });
});

describe('two-pot forge split 50 / 20 / 25 / 0 / 5', () => {
    it('vector and sums (xorshift like the Rust test)', () => {
        expect(forgeSplit(10n * XNT)).toEqual({ backing: 5n * XNT, toPool: 2n * XNT, toExtra: 2_500_000_000n, toDraw: 0n, toArchitect: 500_000_000n });
        let x = 0x2545_F491_4F6C_DD1Dn;
        const M = (1n << 64n) - 1n;
        for (let i = 0; i < 20_000; i++) {
            x ^= (x << 13n) & M; x ^= x >> 7n; x ^= (x << 17n) & M;
            const price = (x % (2_000n * XNT)) + 1n;
            const s = forgeSplit(price);
            expect(s.backing + s.toPool + s.toExtra + s.toDraw + s.toArchitect).toBe(price);
            expect(s.toDraw).toBe(0n);
            expect(s.backing).toBe(price / 2n);
            expect(s.toArchitect >= price / 20n).toBe(true);
        }
    });
});

describe('native market split: 5% architect, 2% base pot, 0 to the extra pot', () => {
    it('vector and sums', () => {
        expect(marketSplit(10n * XNT)).toEqual({ royalty: 500_000_000n, poolFee: 200_000_000n, sellerNet: 9_300_000_000n });
        let x = 0x9E37_79B9_7F4A_7C15n;
        const M = (1n << 64n) - 1n;
        for (let i = 0; i < 20_000; i++) {
            x ^= (x << 13n) & M; x ^= x >> 7n; x ^= (x << 17n) & M;
            const price = x % (100_000n * XNT);
            const s = marketSplit(price);
            expect(s.royalty + s.poolFee + s.sellerNet).toBe(price);
            expect(s.royalty <= price / 20n && s.poolFee <= price / 50n).toBe(true);
        }
    });
    it('the lowest list price that still pays the floor', () => {
        for (const base of ARTIFACT_PRICE) {
            const backing = base / 2n;
            const p = minListPriceForFloor(backing);
            expect(marketSplit(p).sellerNet >= backing).toBe(true);
            expect(marketSplit(p - 1n).sellerNet < backing).toBe(true);
        }
    });
});
