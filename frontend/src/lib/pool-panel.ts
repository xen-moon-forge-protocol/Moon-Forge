/**
 * The Start page's live reward-pool panel (owner request 2026-11-14): the free reward pool read from X1 and the most one
 * week can pay to all burners together, under today's rules (10% of the free pool, EPOCH_BUDGET_BPS) and under the v3
 * rules (8%, the oracle's weekly capacity). Pure functions, so the math and the formatting are unit-tested.
 */
const LAMPORTS_PER_XNT = 1_000_000_000;
/** today's rules (v2 program, EPOCH_BUDGET_BPS = 1000): an epoch pays at most 10% of the free pool */
export const TODAY_WEEK_BPS = 1_000;
/** the v3 rules (planned from the first v3 epoch): a week pays at most 8% of the free pool */
export const V3_WEEK_BPS = 800;

export interface PoolPanel {
    /** free reward pool, XNT */
    poolXnt: number;
    /** most one week can pay to all burners together under today's rules, XNT */
    todayMaxXnt: number;
    /** the same under the v3 rules, XNT */
    v3MaxXnt: number;
    /** read time, "YYYY-MM-DD HH:MM UTC" */
    readAt: string;
}

/** Floors to whole lamports, as the program does (integer division). */
export function weekMaxLamports(freeLamports: number, bps: number): number {
    if (!Number.isFinite(freeLamports) || freeLamports <= 0) return 0;
    return Math.floor((Math.floor(freeLamports) * bps) / 10_000);
}

/** "1,234.57" style, at most `digits` decimals, never scientific notation. */
export function formatXnt(xnt: number, digits = 3): string {
    if (!Number.isFinite(xnt)) return '--';
    return xnt.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function formatUtc(ms: number): string {
    const d = new Date(ms);
    const p2 = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;
}

/**
 * The panel's numbers, or null when there is nothing trustworthy to show (no read, a failed last read, a program that is
 * not initialized, or a value that is not a finite number). The caller shows nothing on null: never a stale figure.
 */
export function poolPanel(read: { freeLamports: number; initialized: boolean; atMs: number } | null, failed: boolean): PoolPanel | null {
    if (!read || failed || !read.initialized || !Number.isFinite(read.freeLamports) || read.freeLamports < 0 || !Number.isFinite(read.atMs)) return null;
    return {
        poolXnt: read.freeLamports / LAMPORTS_PER_XNT,
        todayMaxXnt: weekMaxLamports(read.freeLamports, TODAY_WEEK_BPS) / LAMPORTS_PER_XNT,
        v3MaxXnt: weekMaxLamports(read.freeLamports, V3_WEEK_BPS) / LAMPORTS_PER_XNT,
        readAt: formatUtc(read.atMs),
    };
}
