/**
 * Fair Value Engine — how much the same amount of XEN is worth on each chain right now.
 *
 * v1 used fixed per-chain weights (CWF). v2 weighs every chain by its own XEN market instead, so a weight can
 * never go stale and cannot be gamed by buying cheap XEN on a chain with a generous fixed weight:
 *   value = XEN burned × that chain's XEN price × L / (L + V)
 * (price: median of the hourly closes over 24 h in the chain's deepest eligible pool; L: XEN-side liquidity;
 * V: everything burned on that chain in the epoch). This table is a live approximation from GeckoTerminal,
 * the same source the oracle uses; the oracle's values per burn are published in each epoch file.
 */
import { useEffect, useState } from 'react';
import { Scale } from 'lucide-react';
import { CHAINS, EVM_CHAINS, formatUSD, isPortalDeployed } from '../lib/constants';
import { fetchXenMarket } from './ROICalculator';

type Mkt = { price: number; liquidity: number } | null;
const PER = 1e9; // value of 1 billion XEN

export default function FairValueEngine() {
    const [rows, setRows] = useState<Record<string, Mkt | 'loading'>>(() => Object.fromEntries(EVM_CHAINS.map((k) => [k, 'loading'])));
    useEffect(() => {
        let alive = true;
        (async () => {
            // one chain at a time: GeckoTerminal's free API allows about 30 requests a minute
            for (const k of EVM_CHAINS) {
                const m = await fetchXenMarket(k).catch(() => null);
                if (!alive) return;
                setRows((r) => ({ ...r, [k]: m }));
            }
        })();
        return () => { alive = false; };
    }, []);

    const values = EVM_CHAINS.map((k) => { const m = rows[k]; return m && m !== 'loading' ? m.price * PER : 0; });
    const top = Math.max(...values, 0);

    return (
        <div className="glass-card">
            <div className="flex items-center gap-2 mb-2">
                <Scale className="w-5 h-5 text-forge-gold" />
                <h3 className="font-space text-lg">Fair Value Engine · live chain weights</h3>
            </div>
            <p className="text-sm text-lunar-400 mb-4">
                Each chain's XEN is weighed by its own market, not by a fixed number: the same amount of XEN is worth more where its market price is higher.
                A chain's weight is shown relative to the strongest chain right now.
            </p>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-left text-lunar-400 border-b border-white/10">
                            <th className="py-2 pr-3 font-normal">Chain</th>
                            <th className="py-2 pr-3 font-normal text-right">1B XEN worth</th>
                            <th className="py-2 pr-3 font-normal text-right">XEN-side liquidity</th>
                            <th className="py-2 pr-3 font-normal">Weight</th>
                            <th className="py-2 font-normal">Portal</th>
                        </tr>
                    </thead>
                    <tbody>
                        {EVM_CHAINS.map((k, i) => {
                            const c = CHAINS[k];
                            const m = rows[k];
                            const w = top > 0 ? values[i] / top : 0;
                            return (
                                <tr key={k} className="border-b border-white/5">
                                    <td className="py-2 pr-3"><span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: c.color }} />{c.name}</td>
                                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{m === 'loading' ? '…' : m ? formatUSD(m.price * PER) : '--'}</td>
                                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{m === 'loading' ? '…' : m ? formatUSD(m.liquidity) : '--'}</td>
                                    <td className="py-2 pr-3 min-w-[140px]">
                                        {m && m !== 'loading' && top > 0 ? (
                                            <div className="flex items-center gap-2">
                                                <div className="h-2 flex-1 rounded bg-space-600 overflow-hidden"><div className="h-full bg-forge-orange" style={{ width: `${Math.max(2, w * 100)}%` }} /></div>
                                                <span className="font-mono text-xs tabular-nums w-14 text-right">{w >= 0.01 ? `${(w * 100).toFixed(1)}%` : `${(w * 100).toFixed(3)}%`}</span>
                                            </div>
                                        ) : <span className="text-lunar-500">--</span>}
                                    </td>
                                    <td className="py-2 text-xs">{isPortalDeployed(k) ? <span className="text-green-400">live</span> : <span className="text-lunar-500">follows</span>}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <p className="text-xs text-lunar-500 mt-3">
                What a burn is credited with: XEN burned × that chain's XEN price at the burn hour (median of hourly closes over 24 h in its deepest eligible pool)
                × L / (L + V), where L is the chain's XEN-side liquidity and V everything burned on that chain in the epoch. Thin markets are discounted, so nobody
                can mint cheap XEN on a small chain and burn it for more than it is worth. Prices: GeckoTerminal, the oracle's source; the exact values per burn are in each published epoch file.
            </p>
        </div>
    );
}
