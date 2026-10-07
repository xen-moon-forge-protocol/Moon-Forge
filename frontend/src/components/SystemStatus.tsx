/**
 * Footer status bar — live X1 reads only: current slot, last epoch, oracle key.
 */

import { useState } from 'react';
import { Activity, Server, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { usePoll, useProtocol } from '../lib/hooks';
import { readConnection, X1_RPC } from '../lib/protocol';
import { formatNumber } from '../lib/constants';
import { AddrLink } from './ui';

export default function SystemStatus() {
    const slot = usePoll(() => readConnection.getSlot('confirmed'), [], 15_000);
    const proto = useProtocol(60_000);
    const [expanded, setExpanded] = useState(false);
    const cfg = proto.data?.config;
    const online = slot.data !== null && !slot.error;

    return (
        <footer className="fixed bottom-0 left-0 right-0 z-40">
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full glass !rounded-none border-t border-white/10 px-4 py-2 flex items-center justify-between hover:bg-space-700/50 transition-colors"
            >
                <div className="flex items-center gap-4 text-xs text-lunar-400">
                    <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${online ? 'bg-green-400' : slot.error ? 'bg-red-400' : 'bg-yellow-400'}`} />
                        <span>X1 RPC {online ? 'online' : slot.error ? 'unreachable' : 'connecting'}</span>
                    </div>
                    <span className="hidden sm:inline">Slot: {slot.data !== null ? formatNumber(slot.data) : '--'}</span>
                    <span>Last epoch: {cfg ? `#${Number(cfg.lastEpoch)}` : '--'}</span>
                </div>
                <span className="text-xs text-lunar-400">{expanded ? 'Hide ▼' : 'Details ▲'}</span>
            </button>

            {expanded && (
                <div className="glass !rounded-none border-t border-white/10 p-4">
                    <div className="container mx-auto max-w-4xl grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                        <div className="bg-space-700/50 rounded-xl p-4">
                            <div className="flex items-center gap-2 mb-2"><Server className="w-4 h-4 text-mission-launchpad" /> X1 RPC</div>
                            <div className="font-mono text-xs text-lunar-300 break-all">{X1_RPC}</div>
                            <div className="text-xs text-lunar-400 mt-1">Confirmed slot: {slot.data !== null ? formatNumber(slot.data) : '--'} (refreshed every 15 s)</div>
                        </div>
                        <div className="bg-space-700/50 rounded-xl p-4">
                            <div className="flex items-center gap-2 mb-2"><Activity className="w-4 h-4 text-mission-moon" /> Epochs</div>
                            <div className="text-lunar-300">Last epoch: {cfg ? `#${Number(cfg.lastEpoch)}` : '--'}</div>
                            <div className="text-xs text-lunar-400">
                                Published: {cfg && Number(cfg.lastPublishTs) > 0 ? new Date(Number(cfg.lastPublishTs) * 1000).toLocaleString() : '--'}
                            </div>
                            <Link to="/transparency" className="text-xs text-forge-orange hover:underline inline-flex items-center gap-1 mt-1">Epoch files &amp; proofs <ExternalLink className="w-3 h-3" /></Link>
                        </div>
                        <div className="bg-space-700/50 rounded-xl p-4">
                            <div className="flex items-center gap-2 mb-2">Oracle key</div>
                            <div>{cfg ? <AddrLink address={cfg.oracle} /> : '--'}</div>
                            <div className="text-xs text-lunar-400 mt-1">Can only publish epoch roots (≤ 10% of the free pool, ≥ 6 days apart).</div>
                        </div>
                    </div>
                </div>
            )}
        </footer>
    );
}
