/**
 * PX pricing and the two-pot forge split of the upgraded program: exact integer mirrors of
 * programs/moon-forge/src/instructions/artifacts.rs `current_price`, `next_price` and `forge_split` (u64/u128 math).
 * The price is a pure function of Config (artifact_price, artifact_price_ts, artifacts_alive) and the clock; the site
 * reads Config from X1 and shows the result only under rules 3. The buyer still signs a max price (the program refuses a
 * forge above it), so a stale page can never charge more than it showed.
 */
import {
    ARTIFACT_PRICE, ARTIFACT_SUPPLY, BPS, FORGE_SPLIT_BPS, MAX_PRICE_MULTIPLE, MIN_PRICE_BPS, PRICE_DECAY_PERIOD, PRICE_LAUNCH_TS,
    PRICE_MAX_STEPS, PRICE_UP_DEN, PRICE_UP_NUM,
} from './constants';

/** The Config fields PX reads (Anchor camelCase or plain numbers/strings/BN). */
export interface PxConfig {
    artifactPrice: readonly (bigint | number | string | { toString(): string })[];
    artifactPriceTs: readonly (bigint | number | string | { toString(): string })[];
    artifactsAlive: readonly (number | bigint | string | { toString(): string })[];
}
const big = (v: unknown) => BigInt(String(v ?? '0'));

/** utils.rs bps(): ⌊amount × bps / 10_000⌋. */
export const bps = (amount: bigint, b: bigint) => (amount * b) / BPS;

/** artifacts.rs current_price(c, t, now). */
export function currentPrice(c: PxConfig, t: number, now: number): bigint {
    const base = ARTIFACT_PRICE[t];
    const min = bps(base, MIN_PRICE_BPS[t]);
    const stored = big(c.artifactPrice[t]);
    let p = stored === 0n ? base : stored;
    const since = stored === 0n ? PRICE_LAUNCH_TS : Number(big(c.artifactPriceTs[t]));
    if (Number(big(c.artifactsAlive[t])) >= ARTIFACT_SUPPLY[t]) return p > min ? p : min; // full tier: no decay
    const elapsed = Math.max(0, now - since);
    const periods = Math.floor(elapsed / PRICE_DECAY_PERIOD[t]);
    for (let i = 0; i < Math.min(periods, PRICE_MAX_STEPS); i++) {
        p = (p * PRICE_UP_DEN[t]) / PRICE_UP_NUM[t];
        if (p <= min) return min;
    }
    return p > min ? p : min;
}

/** artifacts.rs next_price(paid, t): ×PRICE_UP, capped at MAX_PRICE_MULTIPLE × base. */
export function nextPrice(paid: bigint, t: number): bigint {
    const cap = ARTIFACT_PRICE[t] * MAX_PRICE_MULTIPLE;
    const n = (paid * PRICE_UP_NUM[t]) / PRICE_UP_DEN[t];
    return n < cap ? n : cap;
}

/** The lowest price a tier can reach (MIN_PRICE_BPS of base). */
export const minPrice = (t: number) => bps(ARTIFACT_PRICE[t], MIN_PRICE_BPS[t]);

/** artifacts.rs forge_split(price): backing, base pot, extra pot, lottery (0), architect (takes the rounding rest). */
export function forgeSplit(price: bigint) {
    const backing = bps(price, FORGE_SPLIT_BPS.backing);
    const toExtra = bps(price, FORGE_SPLIT_BPS.extra);
    const toPool = bps(price, FORGE_SPLIT_BPS.pool);
    const toDraw = bps(price, FORGE_SPLIT_BPS.draw);
    const toArchitect = price - backing - toPool - toExtra - toDraw;
    if (toArchitect < 0n) throw new Error('forge split overflow');
    return { backing, toPool, toExtra, toDraw, toArchitect };
}

/** Seconds until the tier's next decay step (null when it cannot decay: full tier or already at its minimum). */
export function nextDecayIn(c: PxConfig, t: number, now: number): number | null {
    if (Number(big(c.artifactsAlive[t])) >= ARTIFACT_SUPPLY[t]) return null;
    if (currentPrice(c, t, now) <= minPrice(t)) return null;
    const stored = big(c.artifactPrice[t]);
    const since = stored === 0n ? PRICE_LAUNCH_TS : Number(big(c.artifactPriceTs[t]));
    if (now < since) return since - now + PRICE_DECAY_PERIOD[t];
    const into = (now - since) % PRICE_DECAY_PERIOD[t];
    return PRICE_DECAY_PERIOD[t] - into;
}
