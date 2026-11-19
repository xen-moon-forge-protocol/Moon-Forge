import { describe, expect, it } from 'vitest';
import { formatUtc, formatXnt, poolPanel, weekMaxLamports } from '../src/lib/pool-panel';

describe('Start page live pool panel', () => {
    it('caps a week at 10% (today) and 8% (v3) of the free pool, floored to lamports', () => {
        // the 2026-11-02 read: 6,475,019,443 lamports
        expect(weekMaxLamports(6_475_019_443, 1_000)).toBe(647_501_944);
        expect(weekMaxLamports(6_475_019_443, 800)).toBe(518_001_555);
        expect(weekMaxLamports(0, 800)).toBe(0);
        expect(weekMaxLamports(-5, 800)).toBe(0);
        expect(weekMaxLamports(Number.NaN, 800)).toBe(0);
    });

    it('builds the panel from a good read', () => {
        const p = poolPanel({ freeLamports: 6_475_019_443, initialized: true, atMs: Date.UTC(2026, 10, 14, 9, 5) }, false);
        expect(p).not.toBeNull();
        expect(formatXnt(p!.poolXnt)).toBe('6.475');
        expect(formatXnt(p!.todayMaxXnt)).toBe('0.648');
        expect(formatXnt(p!.v3MaxXnt)).toBe('0.518');
        expect(p!.readAt).toBe('2026-11-14 09:05 UTC');
    });

    it('shows nothing rather than a stale or bad number', () => {
        const ok = { freeLamports: 1_000_000_000, initialized: true, atMs: 0 };
        expect(poolPanel(null, false)).toBeNull();
        expect(poolPanel(ok, true)).toBeNull();
        expect(poolPanel({ ...ok, initialized: false }, false)).toBeNull();
        expect(poolPanel({ ...ok, freeLamports: Number.NaN }, false)).toBeNull();
    });

    it('formats XNT without scientific notation', () => {
        expect(formatXnt(1234.5678, 2)).toBe('1,234.57');
        expect(formatXnt(0.0000001)).toBe('0');
        expect(formatXnt(Number.POSITIVE_INFINITY)).toBe('--');
        expect(formatUtc(Date.UTC(2026, 0, 2, 3, 4))).toBe('2026-01-02 03:04 UTC');
    });
});
