import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, fetchProtocol, ProtocolSnapshot } from './protocol';

/** Runs `fn` now, every `intervalMs` (0 = once), and whenever `deps` change. Never invents data: null until loaded. */
export function usePoll<T>(fn: () => Promise<T>, deps: unknown[], intervalMs = 30_000) {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [tick, setTick] = useState(0);
    const fnRef = useRef(fn);
    fnRef.current = fn;

    useEffect(() => {
        let alive = true;
        const run = async () => {
            try {
                const v = await fnRef.current();
                if (alive) { setData(v); setError(null); }
            } catch (e) {
                if (alive) setError(errorMessage(e));
            } finally {
                if (alive) setLoading(false);
            }
        };
        setLoading(true);
        run();
        const id = intervalMs > 0 ? setInterval(run, intervalMs) : undefined;
        return () => { alive = false; if (id) clearInterval(id); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, tick, intervalMs]);

    const reload = useCallback(() => setTick((t) => t + 1), []);
    return { data, error, loading, reload };
}

export function useProtocol(intervalMs = 30_000) {
    return usePoll<ProtocolSnapshot>(() => fetchProtocol(), [], intervalMs);
}

/** Tracks one wallet action at a time: busy label, error, last signature. */
export function useTx() {
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [lastTx, setLastTx] = useState<string | null>(null);
    const [info, setInfo] = useState<string | null>(null);

    const run = useCallback(async <R,>(label: string, fn: () => Promise<R>, onDone?: (r: R) => void) => {
        setBusy(label);
        setError(null);
        setInfo(null);
        try {
            const r = await fn();
            if (typeof r === 'string') setLastTx(r);
            else if (r && typeof r === 'object' && typeof (r as any).tx === 'string') setLastTx((r as any).tx);
            onDone?.(r);
            return r;
        } catch (e) {
            setError(errorMessage(e));
            return undefined;
        } finally {
            setBusy(null);
        }
    }, []);

    return { busy, error, lastTx, info, setInfo, setError, setLastTx, run };
}

/** Current unix time, refreshed every `ms`. */
export function useNow(ms = 1000) {
    const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
    useEffect(() => {
        const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
        return () => clearInterval(id);
    }, [ms]);
    return now;
}
