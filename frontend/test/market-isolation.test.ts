/**
 * E2E-site-chains (the live v2 Forge path, lib/market.ts): one slow, failing or throttled chain must not block the
 * others. weekCapacity names a live chain whose week could not be valued (`unread`) instead of returning null for every
 * chain; it still waits while a chain is being read (each read is time-limited by withTimeout) and gives nothing when no
 * live chain could be read. A failed market read is an error of that chain, never "no market".
 */
import { describe, expect, it } from 'vitest';
import { CHAINS, EVM_CHAINS, isPortalDeployed } from '../src/lib/constants';
import { READ_TIMEOUT_MS, weekCapacity, withTimeout, type ChainRow, type XenMarketLive } from '../src/lib/market';

const live = EVM_CHAINS.filter((k) => isPortalDeployed(k));
const market = (spotUsd: number, liquidityUsd: number): XenMarketLive => ({ spotUsd, liquidityUsd, pools: 1, trades24h: 1, volume24hUsd: 1, at: 0 });
const ok = (burnedWeek: number): ChainRow => ({ market: market(1e-8, 10_000), supply: 1, burnedWeek, stale: false, marketError: false });
const rowsWith = (over: Record<string, ChainRow>): Record<string, ChainRow> =>
    Object.fromEntries(EVM_CHAINS.map((k) => [k, over[k] ?? (isPortalDeployed(k) ? ok(1e9) : 'off')]));

describe('E2E-site-chains: weekCapacity isolates a chain that could not be read', () => {
    it('has at least two live chains to isolate', () => {
        expect(live.length).toBeGreaterThanOrEqual(2);
    });

    it('every live chain read: nothing unread, every chain counted', () => {
        const cap = weekCapacity(rowsWith({}), 100, 0.5, 1.25)!;
        expect(cap).not.toBeNull();
        expect(cap.unread).toEqual([]);
        expect(cap.countedWeekUsd).toBeGreaterThan(0);
    });

    it('a market that failed to load (busy, rate-limited) leaves only that chain out, named', () => {
        const [a] = live;
        const all = weekCapacity(rowsWith({}), 100, 0.5, 1.25)!;
        const cap = weekCapacity(rowsWith({ [a]: { market: null, supply: null, burnedWeek: 1e9, stale: false, marketError: true } }), 100, 0.5, 1.25)!;
        expect(cap).not.toBeNull();
        expect(cap.unread).toEqual([CHAINS[a].name]);
        expect(cap.countedWeekUsd).toBeLessThan(all.countedWeekUsd);
    });

    it('a portal RPC that did not answer leaves only that chain out, named', () => {
        const [, b] = live;
        const cap = weekCapacity(rowsWith({ [b]: { market: market(1e-8, 10_000), supply: null, burnedWeek: null, stale: false, marketError: false } }), 100, 0.5, 1.25)!;
        expect(cap.unread).toEqual([CHAINS[b].name]);
    });

    it('a failed market with no burn this week is read (nothing to value), and "no market" is not an error', () => {
        const [a, b] = live;
        const cap = weekCapacity(rowsWith({
            [a]: { market: null, supply: null, burnedWeek: 0, stale: false, marketError: true },
            [b]: { market: null, supply: 1, burnedWeek: 5e9, stale: false, marketError: false },
        }), 100, 0.5, 1.25)!;
        expect(cap.unread).toEqual([]);
    });

    it('waits while a chain is still being read, and gives nothing when no live chain could be read', () => {
        const [a] = live;
        expect(weekCapacity(rowsWith({ [a]: 'loading' }), 100, 0.5, 1.25)).toBeNull();
        const none = Object.fromEntries(live.map((k) => [k, { market: null, supply: null, burnedWeek: null, stale: false, marketError: true } as ChainRow]));
        expect(weekCapacity(rowsWith(none), 100, 0.5, 1.25)).toBeNull();
        expect(weekCapacity(rowsWith({}), null, 0.5, 1.25)).toBeNull();
        expect(weekCapacity(rowsWith({}), 100, null, 1.25)).toBeNull();
    });
});

describe('E2E-site-chains: every read is time-limited', () => {
    it('withTimeout rejects a read that does not answer, and passes an answer through', async () => {
        await expect(withTimeout(new Promise(() => undefined), 20, 'slow RPC')).rejects.toThrow(/slow RPC: no answer/);
        await expect(withTimeout(Promise.resolve(7), 1_000, 'fast')).resolves.toBe(7);
        await expect(withTimeout(Promise.reject(new Error('boom')), 1_000, 'x')).rejects.toThrow('boom');
        expect(READ_TIMEOUT_MS).toBeGreaterThan(0);
        expect(READ_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    });
});
