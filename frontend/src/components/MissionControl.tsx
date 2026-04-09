/**
 * Moon Forge - Mission Control Component v10.0
 * 
 * COMPREHENSIVE TRANSPARENCY DASHBOARD
 * 
 * Features:
 * - 🏆 Global Leaderboard (Top Burners)
 * - 📊 Global Stats per Chain
 * - 🎯 NFT Usage Statistics  
 * - 💼 Personal Dashboard (when connected)
 * - 📈 Real-time Protocol Health
 * 
 * NO MOCK DATA - shows placeholders until mainnet.
 */

import { useState, useEffect } from 'react';
import {
    Rocket, AlertTriangle, Download, Loader2, Info, Flame, Award,
    History, RefreshCw, Trophy, BarChart3, TrendingUp,
    Crown, Medal, Target, Zap
} from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import { TIERS, formatNumber, formatXNT, shortenAddress, EVM_CHAINS, CHAINS, FEE_STRUCTURE, ARTIFACT_TIERS } from '../lib/constants';
import PoolHealth from './PoolHealth';

// Types
interface GlobalStats {
    totalBurned: Record<string, string>;
    totalMissions: number;
    totalXNTDistributed: string;
    activePilots: number;
    // New Economic Stats
    rewardVaultBalance: number;
    bankrollVaultBalance: number;
    flywheelSubsidyTotal: number;
    totalCommitted: number;
}

interface LeaderboardEntry {
    rank: number;
    address: string;
    totalBurned: string;
    missionsCount: number;
    estimatedXNT: string;
}

interface NFTStats {
    tier: number;
    name: string;
    inUse: number;
    available: number;
    totalMinted: number;
}

interface UserMission {
    id: string;
    tier: number;
    xenBurned: string;
    sourceChain: string;
    startTimestamp: number;
    estimatedXNT: string;
    claimedAmount: string;
    artifactBoost: number;
}

export default function MissionControl() {
    const { evmAddress, x1Address, setX1Address, x1Connected } = useWallet();

    // State
    const [activeTab, setActiveTab] = useState<'dashboard' | 'leaderboard' | 'stats' | 'nfts'>('dashboard');
    const [loading, setLoading] = useState(false);
    const [viewAddress, setViewAddress] = useState('');

    // Data (placeholders until mainnet)
    const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
    const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
    const [nftStats, setNftStats] = useState<NFTStats[]>([]);
    const [userMissions, setUserMissions] = useState<UserMission[]>([]);

    // Load data when X1 address is set
    useEffect(() => {
        if (x1Address) {
            loadAllData();
        }
    }, [x1Address]);

    const loadAllData = async () => {
        setLoading(true);
        try {
            // TODO: In production, fetch from contracts/indexer
            // For now, we show empty/placeholder state

            // These would be real contract calls:
            // const baseContract = new ethers.Contract(CHAINS.x1.baseAddress, BASE_ABI, provider);
            // const stats = await baseContract.getGlobalStats();

            setGlobalStats(null); // No mock data
            setLeaderboard([]);   // No mock data
            setNftStats([]);      // No mock data
            setUserMissions([]);  // No mock data
        } catch (err) {
            console.error('Failed to load data:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleViewDashboard = () => {
        if (viewAddress && viewAddress.startsWith('0x') && viewAddress.length === 42) {
            setX1Address(viewAddress);
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    //                              RENDER
    // ─────────────────────────────────────────────────────────────────────────

    return (
        <div className="max-w-6xl mx-auto">
            {/* Header */}
            <div className="text-center mb-8">
                <h1 className="font-space text-4xl font-bold mb-2">
                    <span className="text-mission-launchpad">🚀</span> Mission Control
                </h1>
                <p className="text-lunar-400">
                    Complete protocol transparency. Track everything.
                </p>
            </div>

            {/* Tab Navigation */}
            <div className="flex flex-wrap justify-center gap-2 mb-8">
                <TabButton
                    active={activeTab === 'dashboard'}
                    onClick={() => setActiveTab('dashboard')}
                    icon={<Rocket className="w-4 h-4" />}
                    label="Your Dashboard"
                />
                <TabButton
                    active={activeTab === 'leaderboard'}
                    onClick={() => setActiveTab('leaderboard')}
                    icon={<Trophy className="w-4 h-4" />}
                    label="Leaderboard"
                />
                <TabButton
                    active={activeTab === 'stats'}
                    onClick={() => setActiveTab('stats')}
                    icon={<BarChart3 className="w-4 h-4" />}
                    label="Global Stats"
                />
                <TabButton
                    active={activeTab === 'nfts'}
                    onClick={() => setActiveTab('nfts')}
                    icon={<Target className="w-4 h-4" />}
                    label="NFT Usage"
                />
            </div>

            {/* Pre-Mainnet Notice */}
            <div className="glass-card bg-amber-500/10 border-amber-500/30 mb-6">
                <div className="flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                    <div>
                        <h4 className="font-medium text-amber-400 mb-1">Pre-Mainnet Mode</h4>
                        <p className="text-lunar-300 text-sm">
                            Real data will populate after mainnet deployment. All sections below show the structure of what will be available.
                        </p>
                    </div>
                </div>
            </div>

            {/* Tab Content */}
            {activeTab === 'dashboard' && (
                <DashboardTab
                    x1Address={x1Address}
                    viewAddress={viewAddress}
                    setViewAddress={setViewAddress}
                    onViewDashboard={handleViewDashboard}
                    missions={userMissions}
                    loading={loading}
                    onRefresh={loadAllData}
                />
            )}

            {activeTab === 'leaderboard' && (
                <LeaderboardTab leaderboard={leaderboard} />
            )}

            {activeTab === 'stats' && (
                <GlobalStatsTab stats={globalStats} />
            )}

            {activeTab === 'nfts' && (
                <NFTStatsTab />
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
//                              TAB COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════

function TabButton({ active, onClick, icon, label }: {
    active: boolean; onClick: () => void; icon: React.ReactNode; label: string;
}) {
    return (
        <button
            onClick={onClick}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl font-medium transition-all ${active
                ? 'bg-forge-orange text-space-900'
                : 'bg-space-700/50 text-lunar-300 hover:bg-space-600/50'
                }`}
        >
            {icon}
            {label}
        </button>
    );
}

// ─────────────────────────────────────────────────────────────────────────
//                              DASHBOARD TAB
// ─────────────────────────────────────────────────────────────────────────

function DashboardTab({ x1Address, viewAddress, setViewAddress, onViewDashboard, missions, loading, onRefresh }: {
    x1Address: string | null;
    viewAddress: string;
    setViewAddress: (v: string) => void;
    onViewDashboard: () => void;
    missions: UserMission[];
    loading: boolean;
    onRefresh: () => void;
}) {
    return (
        <div className="space-y-6">
            {/* How Claiming Works */}
            <div className="glass-card bg-blue-500/10 border-blue-500/30">
                <div className="flex items-start gap-3">
                    <Info className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
                    <div>
                        <h4 className="font-medium text-blue-400 mb-2">How XNT Rewards Work</h4>
                        <ul className="text-lunar-300 text-sm space-y-1">
                            <li>• <strong className="text-white">XNT does NOT auto-transfer</strong> - you must click "Claim"</li>
                            <li>• Rewards are released <strong className="text-forge-gold">linearly</strong> over your vesting period (5, 45, or 180 days)</li>
                            <li>• You can claim <strong className="text-green-400">any available amount at any time</strong> (partial claims OK)</li>
                            <li>• 💡 <strong className="text-amber-400">Gas Tip:</strong> Bulk claims save fees - wait for meaningful amounts</li>
                            <li>• 🎯 <strong className="text-mission-orbit">NFT Boost:</strong> Equip artifact BEFORE burning to apply boost</li>
                        </ul>
                    </div>
                </div>
            </div>

            {/* Connect/View Wallet */}
            {!x1Address ? (
                <div className="glass-card">
                    <h3 className="font-space text-lg mb-4">View Your Dashboard</h3>
                    <p className="text-lunar-400 text-sm mb-4">
                        Enter your X1 wallet address to view your missions (read-only).
                    </p>
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={viewAddress}
                            onChange={(e) => setViewAddress(e.target.value)}
                            placeholder="Enter X1 wallet address"
                            className="input-forge flex-1 font-mono text-sm"
                        />
                        <button onClick={onViewDashboard} className="btn-forge">
                            View
                        </button>
                    </div>
                </div>
            ) : (
                <>
                    {/* Connected Address */}
                    <div className="glass-card bg-green-500/10 border-green-500/30">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full bg-green-400 animate-pulse" />
                                <span className="text-green-400 font-medium">Viewing:</span>
                                <code className="text-sm bg-space-700 px-2 py-0.5 rounded">{shortenAddress(x1Address)}</code>
                            </div>
                            <button onClick={onRefresh} className="btn-outline text-sm flex items-center gap-1">
                                <RefreshCw className="w-4 h-4" />
                                Refresh
                            </button>
                        </div>
                    </div>

                    {/* Summary Stats */}
                    <div className="glass-card">
                        <h3 className="font-space text-lg mb-4 flex items-center gap-2">
                            <Award className="w-5 h-5 text-forge-gold" />
                            Your Summary
                        </h3>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <StatBox label="Total Missions" value={missions.length > 0 ? missions.length.toString() : '--'} suffix="" />
                            <StatBox label="XEN Burned" value="--" suffix="XEN" />
                            <StatBox label="Est. XNT Reward" value="--" suffix="XNT" highlight />
                            <StatBox label="Already Claimed" value="--" suffix="XNT" />
                        </div>
                    </div>

                    {/* Burn History by Chain */}
                    <div className="glass-card">
                        <h3 className="font-space text-lg mb-4 flex items-center gap-2">
                            <History className="w-5 h-5 text-mission-orbit" />
                            Your Burns by Chain
                        </h3>
                        <div className="grid grid-cols-5 gap-3">
                            {EVM_CHAINS.map(chainKey => (
                                <div key={chainKey} className="bg-space-700/50 rounded-lg p-4 text-center">
                                    <div
                                        className="w-6 h-6 rounded-full mx-auto mb-2"
                                        style={{ backgroundColor: CHAINS[chainKey].color }}
                                    />
                                    <div className="text-sm font-medium text-white">{CHAINS[chainKey].shortName}</div>
                                    <div className="text-lg font-space text-forge-gold">--</div>
                                    <div className="text-xs text-lunar-400">XEN burned</div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Active Missions */}
                    <div className="glass-card">
                        <h3 className="font-space text-lg mb-4 flex items-center gap-2">
                            <Rocket className="w-5 h-5 text-mission-launchpad" />
                            Active Missions
                        </h3>
                        {missions.length === 0 ? (
                            <div className="text-center py-8">
                                <Rocket className="w-12 h-12 mx-auto mb-3 text-lunar-400" />
                                <p className="text-lunar-400 mb-4">No active missions found.</p>
                                <a href="/Moon-Forge/forge" className="btn-forge inline-flex items-center gap-2">
                                    <Flame className="w-4 h-4" />
                                    Enter The Forge
                                </a>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                {missions.map(mission => (
                                    <MissionCard key={mission.id} mission={mission} />
                                ))}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────
//                              LEADERBOARD TAB
// ─────────────────────────────────────────────────────────────────────────

function LeaderboardTab({ leaderboard }: { leaderboard: LeaderboardEntry[] }) {
    return (
        <div className="space-y-6">
            <div className="glass-card">
                <h3 className="font-space text-xl mb-4 flex items-center gap-2">
                    <Trophy className="w-6 h-6 text-forge-gold" />
                    Top Burners Leaderboard
                </h3>
                <p className="text-lunar-400 text-sm mb-6">
                    The pilots who have burned the most XEN across all chains.
                </p>

                {leaderboard.length === 0 ? (
                    <div className="text-center py-12">
                        <Trophy className="w-16 h-16 mx-auto mb-4 text-lunar-400" />
                        <h4 className="text-xl text-white mb-2">Leaderboard Coming Soon</h4>
                        <p className="text-lunar-400">Rankings will appear after mainnet launch.</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead>
                                <tr className="text-left text-lunar-400 text-sm border-b border-white/10">
                                    <th className="pb-3 pr-4">Rank</th>
                                    <th className="pb-3 pr-4">Pilot</th>
                                    <th className="pb-3 pr-4 text-right">Total Burned</th>
                                    <th className="pb-3 pr-4 text-right">Missions</th>
                                    <th className="pb-3 text-right">Est. XNT</th>
                                </tr>
                            </thead>
                            <tbody>
                                {leaderboard.map(entry => (
                                    <tr key={entry.address} className="border-b border-white/5">
                                        <td className="py-3 pr-4">
                                            {entry.rank === 1 && <Crown className="w-5 h-5 text-forge-gold inline" />}
                                            {entry.rank === 2 && <Medal className="w-5 h-5 text-gray-300 inline" />}
                                            {entry.rank === 3 && <Medal className="w-5 h-5 text-amber-600 inline" />}
                                            {entry.rank > 3 && <span className="text-lunar-400">#{entry.rank}</span>}
                                        </td>
                                        <td className="py-3 pr-4 font-mono text-sm">{shortenAddress(entry.address)}</td>
                                        <td className="py-3 pr-4 text-right text-forge-gold font-bold">{entry.totalBurned} XEN</td>
                                        <td className="py-3 pr-4 text-right">{entry.missionsCount}</td>
                                        <td className="py-3 text-right text-green-400">{entry.estimatedXNT} XNT</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Placeholder for Top 10 */}
            <div className="glass-card">
                <h4 className="font-space text-lg mb-4">Leaderboard Preview</h4>
                <div className="space-y-2">
                    {[1, 2, 3, 4, 5].map(i => (
                        <div key={i} className="flex items-center gap-4 p-3 bg-space-700/30 rounded-lg">
                            <div className="w-8 h-8 rounded-full bg-space-600 flex items-center justify-center">
                                {i === 1 && <Crown className="w-4 h-4 text-forge-gold" />}
                                {i === 2 && <Medal className="w-4 h-4 text-gray-300" />}
                                {i === 3 && <Medal className="w-4 h-4 text-amber-600" />}
                                {i > 3 && <span className="text-lunar-400 text-sm">#{i}</span>}
                            </div>
                            <div className="flex-1">
                                <div className="h-4 bg-space-600 rounded w-32"></div>
                            </div>
                            <div className="text-lunar-400">-- XEN</div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────
//                              GLOBAL STATS TAB
// ─────────────────────────────────────────────────────────────────────────

function GlobalStatsTab({ stats }: { stats: GlobalStats | null }) {
    return (
        <div className="space-y-6">
            {/* XNT Pool Highlight - MAIN ATTRACTION */}
            <div className="glass-card border-none bg-transparent p-0">
                {/* Stats do Cofrinho (Dual-Vault Display) */}
                <PoolHealth
                    rewardBalance={stats?.rewardVaultBalance || 0}
                    bankrollBalance={stats?.bankrollVaultBalance || 0}
                    totalCommitted={stats?.totalCommitted || 0}
                    flywheelSubsidy={stats?.flywheelSubsidyTotal || 0}
                />
            </div>

            {/* Protocol Overview */}
            <div className="glass-card">
                <h3 className="font-space text-xl mb-4 flex items-center gap-2">
                    <BarChart3 className="w-6 h-6 text-mission-launchpad" />
                    Protocol Overview
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <StatBox label="Total XEN Burned" value="--" suffix="XEN" />
                    <StatBox label="Active Pilots" value="--" suffix="" />
                    <StatBox label="Total Missions" value="--" suffix="" />
                    <StatBox label="XNT Distributed" value="--" suffix="XNT" highlight />
                </div>
            </div>

            {/* Burns by Chain */}
            <div className="glass-card">
                <h3 className="font-space text-xl mb-4 flex items-center gap-2">
                    <Flame className="w-6 h-6 text-forge-orange" />
                    XEN Burned by Chain
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
                    {EVM_CHAINS.map(chainKey => (
                        <div key={chainKey} className="bg-space-700/50 rounded-xl p-4 text-center">
                            <div
                                className="w-8 h-8 rounded-full mx-auto mb-3"
                                style={{ backgroundColor: CHAINS[chainKey].color }}
                            />
                            <div className="font-space text-lg text-white">{CHAINS[chainKey].name}</div>
                            <div className="text-2xl font-space text-forge-gold mt-2">--</div>
                            <div className="text-sm text-lunar-400">XEN burned</div>
                            <div className="text-xs text-lunar-400 mt-1">-- missions</div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Fee Distribution Transparency */}
            <div className="glass-card">
                <h3 className="font-space text-xl mb-4 flex items-center gap-2">
                    <TrendingUp className="w-6 h-6 text-green-400" />
                    Fee Distribution
                </h3>
                <p className="text-lunar-400 text-sm mb-4">
                    How every XNT from NFT purchases is distributed:
                </p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4 text-center">
                        <div className="text-2xl font-space text-green-400">{FEE_STRUCTURE.rewardPool}%</div>
                        <div className="text-sm text-lunar-400">Reward Pool</div>
                    </div>
                    <div className="bg-mission-launchpad/10 border border-mission-launchpad/30 rounded-xl p-4 text-center">
                        <div className="text-2xl font-space text-mission-launchpad">{FEE_STRUCTURE.oracle}%</div>
                        <div className="text-sm text-lunar-400">Oracle Gas</div>
                    </div>
                    <div className="bg-mission-orbit/10 border border-mission-orbit/30 rounded-xl p-4 text-center">
                        <div className="text-2xl font-space text-mission-orbit">{FEE_STRUCTURE.referrer}%</div>
                        <div className="text-sm text-lunar-400">Referrer</div>
                    </div>
                    <div className="bg-forge-orange/10 border border-forge-orange/30 rounded-xl p-4 text-center">
                        <div className="text-2xl font-space text-forge-orange">{FEE_STRUCTURE.dev}%</div>
                        <div className="text-sm text-lunar-400">Dev Wallet</div>
                        <div className="text-xs text-lunar-400 mt-1">Transparent address</div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────
//                              NFT STATS TAB
// ─────────────────────────────────────────────────────────────────────────

function NFTStatsTab() {
    return (
        <div className="space-y-6">
            <div className="glass-card">
                <h3 className="font-space text-xl mb-4 flex items-center gap-2">
                    <Target className="w-6 h-6 text-mission-orbit" />
                    Artifact Usage Statistics
                </h3>
                <p className="text-lunar-400 text-sm mb-6">
                    Track how many NFTs are in active use vs available for purchase.
                </p>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    {ARTIFACT_TIERS.map(tier => (
                        <div key={tier.tier} className="bg-space-700/50 rounded-xl p-4">
                            <div className="flex items-center justify-between mb-3">
                                <span className="text-lg font-medium text-white">{tier.name}</span>
                                <span className="text-xs px-2 py-0.5 rounded-full bg-forge-gold/20 text-forge-gold">
                                    +{tier.boost}%
                                </span>
                            </div>
                            <div className="space-y-2 text-sm">
                                <div className="flex justify-between">
                                    <span className="text-lunar-400">Max Supply</span>
                                    <span className="text-white">{tier.maxSupply}</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-lunar-400">In Use</span>
                                    <span className="text-mission-launchpad">--</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-lunar-400">Available</span>
                                    <span className="text-green-400">--</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-lunar-400">Base Price</span>
                                    <span className="text-forge-gold">{tier.basePrice} XNT</span>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* NFT Rules */}
            <div className="glass-card bg-mission-orbit/10 border-mission-orbit/30">
                <h4 className="font-space text-lg mb-4 flex items-center gap-2">
                    <Zap className="w-5 h-5 text-mission-orbit" />
                    NFT Rules Summary
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                    <div className="space-y-2">
                        <p className="text-lunar-300">🔒 <strong className="text-white">Lock Mechanics:</strong></p>
                        <ul className="text-lunar-400 ml-4 space-y-1">
                            <li>• NFT is locked when equipped to a mission</li>
                            <li>• Returns to pool when mission completes OR you eject</li>
                            <li>• Single-use per mission (can reuse after)</li>
                        </ul>
                    </div>
                    <div className="space-y-2">
                        <p className="text-lunar-300">📈 <strong className="text-white">Price Dynamics:</strong></p>
                        <ul className="text-lunar-400 ml-4 space-y-1">
                            <li>• Lunar Dust: <span className="text-green-400">FIXED</span> at 10 XNT</li>
                            <li>• Others: +5% after each purchase</li>
                            <li>• -5% if no sale for 7 days</li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
//                              SHARED COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════

function StatBox({ label, value, suffix, highlight }: {
    label: string; value: string; suffix: string; highlight?: boolean;
}) {
    return (
        <div className={`p-4 rounded-xl ${highlight ? 'bg-forge-orange/10 border border-forge-orange/30' : 'bg-space-700/50'}`}>
            <div className="text-xs text-lunar-400 mb-1">{label}</div>
            <div className={`font-space text-xl ${highlight ? 'text-forge-gold' : 'text-white'}`}>
                {value} <span className="text-sm text-lunar-400">{suffix}</span>
            </div>
        </div>
    );
}

function MissionCard({ mission }: { mission: UserMission }) {
    const { x1Connected, x1Connection, x1Address } = useWallet();
    const [claiming, setClaiming] = useState(false);
    const tierInfo = TIERS[mission.tier];

    const handleClaim = async () => {
        // Claim requires X1 Wallet (SVM) connected — x1Address is a Base58 Solana public key
        if (!x1Address || !x1Connected || !x1Connection) return;
        setClaiming(true);
        try {
            // TODO: when MoonForge Anchor program is deployed on X1:
            //   1. Fetch Merkle proof from oracle API: GET /api/proof?address={x1Address}&epoch={epoch}
            //   2. Call Anchor program instruction: claim(proof, amount, tier)
            //   3. X1 Wallet signs transaction via window.x1.signAndSendTransaction(tx)
            console.log("Claiming mission:", mission.id, "on X1 SVM via X1 Wallet");
            alert("X1 Anchor program not yet deployed. XNT claim via X1 Wallet will be available at mainnet launch.");
        } catch (err) {
            console.error(err);
        } finally {
            setClaiming(false);
        }
    };

    return (
        <div className="bg-space-700/50 rounded-xl p-4 border border-white/5 hover:border-white/10 transition-colors">
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-space-600 flex items-center justify-center text-2xl">
                        {tierInfo.icon}
                    </div>
                    <div>
                        <div className="font-space text-white leading-tight" style={{ color: tierInfo.color }}>{tierInfo.name}</div>
                        <div className="text-xs text-lunar-500">Mission ID: {shortenAddress(mission.id)}</div>
                    </div>
                </div>
                <div className="text-right">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 font-medium tracking-wide">ACTIVE</span>
                    <div className="text-[10px] text-lunar-500 mt-1 uppercase tracking-tighter">Vesting {tierInfo.duration}d</div>
                </div>
            </div>

            <div className="grid grid-cols-3 gap-4 mb-5 p-3 bg-space-800/50 rounded-lg">
                <div>
                    <div className="text-[10px] text-lunar-400 uppercase">Burned</div>
                    <div className="text-sm text-white font-bold">{formatNumber(parseFloat(mission.xenBurned))} XEN</div>
                </div>
                <div>
                    <div className="text-[10px] text-lunar-400 uppercase">Pending XNT</div>
                    <div className="text-sm text-forge-gold font-bold">{formatXNT(BigInt(mission.estimatedXNT))} XNT</div>
                </div>
                <div>
                    <div className="text-[10px] text-lunar-400 uppercase">Boost</div>
                    <div className="text-sm text-mission-orbit font-bold">
                        {mission.artifactBoost > 0 ? `+${mission.artifactBoost}%` : 'NONE'}
                    </div>
                </div>
            </div>

            <div className="space-y-3">
                <button
                    onClick={handleClaim}
                    disabled={claiming}
                    className="w-full btn-forge py-2 text-sm flex items-center justify-center gap-2"
                >
                    {claiming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    {claiming ? 'Processing Claim...' : 'CLAIM AVAILABLE XNT'}
                </button>

                <div className="flex items-start gap-2 p-2 bg-amber-500/5 border border-amber-500/20 rounded-lg">
                    <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                    <p className="text-[10px] text-amber-400 leading-normal">
                        <strong>First Claim Note:</strong> A one-time network storage fee (~0.05 XNT) will be charged to secure your mission record on X1.
                    </p>
                </div>
            </div>
        </div>
    );
}
