import React, { useState, useEffect } from 'react';
import { Link2, Lock, Unlock, Clock, CheckCircle, Globe } from 'lucide-react';

interface ChainInfo {
    chainId: number;
    name: string;
    icon: string;
    unlockDay: number;
}

interface ChainStatusProps {
    launchTimestamp: number; // Unix timestamp in ms
}

// Default chain configuration matching Oracle
const CHAINS: ChainInfo[] = [
    { chainId: 1, name: 'Ethereum', icon: '⟠', unlockDay: 0 },
    { chainId: 10, name: 'Optimism', icon: '🔴', unlockDay: 0 },
    { chainId: 56, name: 'BSC', icon: '💛', unlockDay: 14 },
    { chainId: 137, name: 'Polygon', icon: '💜', unlockDay: 27 },
    { chainId: 43114, name: 'Avalanche', icon: '🔺', unlockDay: 27 },
];

/**
 * CHAIN STATUS v8.1
 * Visual display of active vs locked chains with unlock countdown
 */
export default function ChainStatus({ launchTimestamp }: ChainStatusProps) {
    const [daysSinceLaunch, setDaysSinceLaunch] = useState(0);

    useEffect(() => {
        const updateDays = () => {
            const now = Date.now();
            const diff = now - launchTimestamp;
            setDaysSinceLaunch(Math.floor(diff / (1000 * 60 * 60 * 24)));
        };

        updateDays();
        const interval = setInterval(updateDays, 60000); // Update every minute
        return () => clearInterval(interval);
    }, [launchTimestamp]);

    const isChainActive = (chain: ChainInfo) => daysSinceLaunch >= chain.unlockDay;

    const getDaysUntilUnlock = (chain: ChainInfo) => {
        const remaining = chain.unlockDay - daysSinceLaunch;
        return remaining > 0 ? remaining : 0;
    };

    const activeChains = CHAINS.filter(c => isChainActive(c));
    const lockedChains = CHAINS.filter(c => !isChainActive(c));

    return (
        <div className="glass-card p-6 rounded-xl border border-amber-500/20">
            {/* Header */}
            <div className="flex items-center gap-3 mb-6">
                <Globe className="w-6 h-6 text-amber-400" />
                <h2 className="text-xl font-bold text-amber-400">Chain Status</h2>
                <span className="ml-auto text-xs text-gray-500">
                    Day {daysSinceLaunch} since launch
                </span>
            </div>

            {/* Active Chains */}
            <div className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                    <Unlock className="w-4 h-4 text-green-400" />
                    <span className="text-sm font-bold text-green-400">Active Chains</span>
                    <span className="text-xs text-gray-500">({activeChains.length})</span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                    {activeChains.map(chain => (
                        <div
                            key={chain.chainId}
                            className="flex items-center gap-3 p-3 bg-green-500/10 border border-green-500/30 rounded-lg"
                        >
                            <span className="text-2xl">{chain.icon}</span>
                            <div className="flex-1">
                                <p className="text-sm font-bold text-white">{chain.name}</p>
                                <p className="text-xs text-green-400 flex items-center gap-1">
                                    <CheckCircle className="w-3 h-3" />
                                    Burning enabled
                                </p>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Locked Chains */}
            {lockedChains.length > 0 && (
                <div>
                    <div className="flex items-center gap-2 mb-3">
                        <Lock className="w-4 h-4 text-gray-500" />
                        <span className="text-sm font-bold text-gray-500">Coming Soon</span>
                        <span className="text-xs text-gray-600">({lockedChains.length})</span>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        {lockedChains.map(chain => {
                            const daysUntil = getDaysUntilUnlock(chain);
                            return (
                                <div
                                    key={chain.chainId}
                                    className="flex items-center gap-3 p-3 bg-black/30 border border-gray-700 rounded-lg opacity-70"
                                >
                                    <span className="text-2xl grayscale">{chain.icon}</span>
                                    <div className="flex-1">
                                        <p className="text-sm font-bold text-gray-400">{chain.name}</p>
                                        <p className="text-xs text-amber-500 flex items-center gap-1">
                                            <Clock className="w-3 h-3" />
                                            Unlocks in {daysUntil} days
                                        </p>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Rollout Timeline */}
            <div className="mt-6 pt-4 border-t border-gray-800">
                <p className="text-xs text-gray-500 mb-3">Rollout Timeline</p>
                <div className="relative">
                    {/* Progress bar */}
                    <div className="absolute top-2 left-0 right-0 h-1 bg-gray-700 rounded-full">
                        <div
                            className="h-full bg-gradient-to-r from-green-500 to-amber-500 rounded-full transition-all duration-500"
                            style={{ width: `${Math.min((daysSinceLaunch / 30) * 100, 100)}%` }}
                        />
                    </div>

                    {/* Milestones */}
                    <div className="flex justify-between pt-4">
                        <div className="text-center">
                            <div className={`w-4 h-4 rounded-full mx-auto mb-1 ${daysSinceLaunch >= 0 ? 'bg-green-500' : 'bg-gray-700'}`} />
                            <p className="text-xs text-gray-500">Day 0</p>
                            <p className="text-xs text-gray-400">ETH/OP</p>
                        </div>
                        <div className="text-center">
                            <div className={`w-4 h-4 rounded-full mx-auto mb-1 ${daysSinceLaunch >= 14 ? 'bg-green-500' : 'bg-gray-700'}`} />
                            <p className="text-xs text-gray-500">Day 14</p>
                            <p className="text-xs text-gray-400">BSC</p>
                        </div>
                        <div className="text-center">
                            <div className={`w-4 h-4 rounded-full mx-auto mb-1 ${daysSinceLaunch >= 27 ? 'bg-green-500' : 'bg-gray-700'}`} />
                            <p className="text-xs text-gray-500">Day 27</p>
                            <p className="text-xs text-gray-400">MATIC/AVAX</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
