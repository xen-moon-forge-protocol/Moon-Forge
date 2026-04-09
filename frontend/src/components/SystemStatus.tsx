/**
 * Moon Forge - System Status Component v9.0
 * 
 * Shows Oracle gas balance and server health.
 * Transparency dashboard - NO MOCK DATA, shows placeholders until mainnet.
 */

import { useState, useEffect } from 'react';
import { Activity, Fuel, Server, ExternalLink, AlertTriangle } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import { FEE_STRUCTURE } from '../lib/constants';

interface SystemHealth {
    oracleGas: string | null;
    serverStatus: 'online' | 'offline' | 'unknown';
    lastEpoch: number | null;
    lastUpdate: string | null;
}

export default function SystemStatus() {
    const { x1Connected } = useWallet();

    const [health, setHealth] = useState<SystemHealth>({
        oracleGas: null,  // No mock data
        serverStatus: 'unknown',
        lastEpoch: null,
        lastUpdate: null,
    });

    const [expanded, setExpanded] = useState(false);
    const [loading, setLoading] = useState(false);

    // Check server status (ping endpoint when available)
    useEffect(() => {
        const checkStatus = async () => {
            try {
                // TODO: In production, ping actual health endpoint
                // For now, just mark as unknown until mainnet
                setHealth(prev => ({
                    ...prev,
                    serverStatus: 'unknown',
                    lastUpdate: new Date().toISOString(),
                }));
            } catch {
                setHealth(prev => ({ ...prev, serverStatus: 'offline' }));
            }
        };

        checkStatus();
        const interval = setInterval(checkStatus, 60000); // Check every minute
        return () => clearInterval(interval);
    }, []);

    const gasPercentage = health.oracleGas ? Math.min(100, (parseFloat(health.oracleGas) / 100) * 100) : 0;
    const gasColor = health.oracleGas
        ? (gasPercentage > 50 ? 'bg-green-500' : gasPercentage > 20 ? 'bg-yellow-500' : 'bg-red-500')
        : 'bg-gray-500';

    return (
        <footer className="fixed bottom-0 left-0 right-0 z-40">
            {/* Collapsed Bar */}
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full glass border-t border-white/10 px-4 py-2 flex items-center justify-between hover:bg-space-700/50 transition-colors"
            >
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${health.serverStatus === 'online' ? 'bg-green-400 animate-pulse' : health.serverStatus === 'offline' ? 'bg-red-400' : 'bg-yellow-400'}`} />
                        <span className="text-xs text-lunar-400">System Status</span>
                    </div>

                    <div className="flex items-center gap-2">
                        <Fuel className="w-4 h-4 text-lunar-400" />
                        <div className="w-20 h-2 bg-space-600 rounded-full overflow-hidden">
                            <div
                                className={`h-full ${gasColor} transition-all duration-500`}
                                style={{ width: health.oracleGas ? `${gasPercentage}%` : '0%' }}
                            />
                        </div>
                        <span className="text-xs text-lunar-300">
                            {health.oracleGas ? `${health.oracleGas} XNT` : '-- XNT'}
                        </span>
                    </div>
                </div>

                <span className="text-xs text-lunar-400">
                    {expanded ? 'Hide Details ▼' : 'Show Details ▲'}
                </span>
            </button>

            {/* Expanded Panel */}
            {expanded && (
                <div className="glass border-t border-white/10 p-4">
                    <div className="container mx-auto max-w-4xl">
                        <h3 className="font-space text-lg text-forge-gold mb-4">System Transparency Dashboard</h3>

                        {/* Pre-Mainnet Notice */}
                        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 mb-4 flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 text-amber-400" />
                            <span className="text-sm text-amber-400">Pre-mainnet preview. Live data will appear after deployment.</span>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            {/* Oracle Gas Tank */}
                            <div className="bg-space-700/50 rounded-xl p-4">
                                <div className="flex items-center gap-2 mb-2">
                                    <Fuel className="w-5 h-5 text-forge-orange" />
                                    <span className="text-sm font-medium">Oracle Gas Tank</span>
                                </div>
                                <div className="text-2xl font-space text-white mb-1">
                                    {health.oracleGas ?? '--'} <span className="text-sm text-lunar-400">XNT</span>
                                </div>
                                <div className="w-full h-2 bg-space-600 rounded-full overflow-hidden mb-2">
                                    <div
                                        className={`h-full ${gasColor}`}
                                        style={{ width: health.oracleGas ? `${gasPercentage}%` : '0%' }}
                                    />
                                </div>
                                <p className="text-xs text-lunar-400">
                                    Auto-refueled by {FEE_STRUCTURE.oracle}% of NFT sales.
                                </p>
                            </div>

                            {/* Server Health */}
                            <div className="bg-space-700/50 rounded-xl p-4">
                                <div className="flex items-center gap-2 mb-2">
                                    <Server className="w-5 h-5 text-mission-launchpad" />
                                    <span className="text-sm font-medium">Server Heartbeat</span>
                                </div>
                                <div className="flex items-center gap-2 mb-2">
                                    <div className={`w-3 h-3 rounded-full ${health.serverStatus === 'online' ? 'bg-green-400 animate-pulse' : health.serverStatus === 'offline' ? 'bg-red-400' : 'bg-yellow-400'}`} />
                                    <span className="text-xl font-space capitalize">
                                        {health.serverStatus === 'unknown' ? 'Pending' : health.serverStatus}
                                    </span>
                                </div>
                                <p className="text-xs text-lunar-400">
                                    {health.lastUpdate
                                        ? `Last check: ${new Date(health.lastUpdate).toLocaleString()}`
                                        : 'Waiting for mainnet...'}
                                </p>
                            </div>

                            {/* Current Epoch */}
                            <div className="bg-space-700/50 rounded-xl p-4">
                                <div className="flex items-center gap-2 mb-2">
                                    <Activity className="w-5 h-5 text-mission-moon" />
                                    <span className="text-sm font-medium">Current Epoch</span>
                                </div>
                                <div className="text-2xl font-space text-forge-gold mb-1">
                                    {health.lastEpoch !== null ? `#${health.lastEpoch}` : '--'}
                                </div>
                                <p className="text-xs text-lunar-400 mb-2">
                                    Rewards calculated weekly.
                                </p>
                                <a
                                    href="https://github.com/MoonForge/protocol/blob/main/proofs/"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs text-forge-orange hover:underline flex items-center gap-1"
                                >
                                    View Proofs <ExternalLink className="w-3 h-3" />
                                </a>
                            </div>
                        </div>

                        {/* Fee Info */}
                        <div className="mt-4 p-3 bg-space-700/30 rounded-xl flex items-center justify-between">
                            <div>
                                <p className="text-sm text-lunar-300">
                                    💡 Early-exit penalty split: Pool {FEE_STRUCTURE.rewardPool}%, Oracle {FEE_STRUCTURE.oracle}%, Referrer {FEE_STRUCTURE.referrer}%, Dev {FEE_STRUCTURE.dev}%
                                </p>
                                <p className="text-xs text-lunar-400">
                                    Normal XEN burns have zero protocol fees.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </footer>
    );
}
