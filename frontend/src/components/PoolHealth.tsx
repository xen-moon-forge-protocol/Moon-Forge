import React from 'react';
import { Shield, AlertTriangle, CheckCircle, RefreshCw, Zap } from 'lucide-react';
import { formatXNT } from '../lib/constants';

interface PoolHealthProps {
    bankrollBalance: number;  // XNT in Gambling Vault
    rewardBalance: number;    // XNT in Burner Vault
    totalCommitted: number;   // XNT owed to burners (vesting)
    flywheelSubsidy: number;  // Total subsidy amount transferred (cumulative)
}

/**
 * POOL HEALTH & ECONOMY DASHBOARD v9.0
 * Visualizes the Dual-Vault Architecture and Flywheel Subsidy
 */
export default function PoolHealth({
    bankrollBalance = 0,
    rewardBalance = 0,
    totalCommitted = 0,
    flywheelSubsidy = 0,
}: PoolHealthProps) {

    // 1. Reward Vault Health (Solvency for Burners)
    const solvencyRatio = totalCommitted > 0
        ? (rewardBalance / totalCommitted) * 100
        : 100;

    // 2. Bankroll Health (Risk for Gamblers)
    // Healthy if Bankroll is at least 10% of Reward Vault (arbitrary safety metric)
    const bankrollHealthRatio = rewardBalance > 0
        ? (bankrollBalance / (rewardBalance * 0.1)) * 100
        : 100;

    // Determine Reward Vault Status
    const getRewardStatus = () => {
        if (solvencyRatio >= 100) return {
            status: 'SOLVENT', color: 'green', icon: CheckCircle,
            bg: 'bg-green-500/10', text: 'text-green-400', border: 'border-green-500/30'
        };
        if (solvencyRatio >= 80) return {
            status: 'STABLE', color: 'yellow', icon: Shield,
            bg: 'bg-yellow-500/10', text: 'text-yellow-400', border: 'border-yellow-500/30'
        };
        return {
            status: 'UNDERFUNDED', color: 'red', icon: AlertTriangle,
            bg: 'bg-red-500/10', text: 'text-red-400', border: 'border-red-500/30'
        };
    };

    const rewardStatus = getRewardStatus();
    const RewardIcon = rewardStatus.icon;

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

            {/* VAULT 1: REWARD POOL (Burners) */}
            <div className={`rounded-xl border ${rewardStatus.border} ${rewardStatus.bg} p-4 relative overflow-hidden`}>
                <div className="flex items-center justify-between mb-4 relative z-10">
                    <div className="flex items-center gap-2">
                        <RewardIcon className={`w-5 h-5 ${rewardStatus.text}`} />
                        <span className={`text-sm font-bold ${rewardStatus.text}`}>REWARD VAULT</span>
                    </div>
                    <div className={`text-xs px-2 py-1 rounded-full bg-black/30 ${rewardStatus.text}`}>
                        {solvencyRatio.toFixed(0)}% Solvency
                    </div>
                </div>

                <div className="text-3xl font-space font-bold text-white mb-1 relative z-10">
                    {formatXNT(BigInt(Math.floor(rewardBalance * 1e9)))} <span className="text-sm text-lunar-500">XNT</span>
                </div>
                <div className="text-xs text-lunar-400 mb-4 relative z-10">
                    Reserved for XEN Burners
                </div>

                {/* Flywheel Subsidy Ticker */}
                <div className="mt-4 pt-3 border-t border-white/10 relative z-10">
                    <div className="flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1 text-forge-gold">
                            <RefreshCw className="w-3 h-3 animate-spin-slow" />
                            Flywheel Subsidy In
                        </span>
                        <span className="font-mono text-green-400">+{formatXNT(BigInt(Math.floor(flywheelSubsidy * 1e9)))} XNT</span>
                    </div>
                </div>

                {/* Background Decoration */}
                <div className="absolute -right-4 -bottom-4 w-24 h-24 bg-green-500/10 rounded-full blur-xl z-0" />
            </div>

            {/* VAULT 2: BANKROLL (Gamblers) */}
            <div className="rounded-xl border border-forge-orange/30 bg-forge-orange/5 p-4 relative overflow-hidden">
                <div className="flex items-center justify-between mb-4 relative z-10">
                    <div className="flex items-center gap-2">
                        <Zap className="w-5 h-5 text-forge-orange" />
                        <span className="text-sm font-bold text-forge-orange">BANKROLL VAULT</span>
                    </div>
                    <div className="text-xs px-2 py-1 rounded-full bg-black/30 text-forge-orange">
                        Active
                    </div>
                </div>

                <div className="text-3xl font-space font-bold text-white mb-1 relative z-10">
                    {formatXNT(BigInt(Math.floor(bankrollBalance * 1e9)))} <span className="text-sm text-lunar-500">XNT</span>
                </div>
                <div className="text-xs text-lunar-400 mb-4 relative z-10">
                    Liquidity for Casino Games
                </div>

                {/* Bankroll Health Bar */}
                <div className="mt-4 pt-3 border-t border-white/10 relative z-10">
                    <div className="flex justify-between text-xs text-lunar-500 mb-1">
                        <span>Utilization Limit</span>
                        <span>{bankrollHealthRatio > 100 ? 'Healthy' : 'Low'}</span>
                    </div>
                    <div className="w-full h-1.5 bg-black/50 rounded-full overflow-hidden">
                        <div
                            className="h-full bg-forge-orange rounded-full"
                            style={{ width: `${Math.min(bankrollHealthRatio, 100)}%` }}
                        />
                    </div>
                </div>

                {/* Background Decoration */}
                <div className="absolute -right-4 -bottom-4 w-24 h-24 bg-forge-orange/10 rounded-full blur-xl z-0" />
            </div>
        </div>
    );
}
