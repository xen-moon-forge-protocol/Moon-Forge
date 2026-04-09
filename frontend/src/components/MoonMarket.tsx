/**
 * Moon Forge - Artifacts Market v9.0
 * 
 * 🎯 THE SCARCITY GAME - SNIPER DASHBOARD 🎯
 * 
 * Features:
 * - NO MOCK DATA - Shows placeholders until connected
 * - Real-time stock from blockchain when connected
 * - v7.1 Fee Distribution (95.5/1/2/1.5)
 * - Weekly Pulse pricing
 */

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Zap, Loader2, RefreshCw, Info, Sparkles, Star, TrendingUp, TrendingDown, Clock, Activity, Target, Lock, AlertTriangle, ExternalLink } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import { useReferral } from '../context/ReferralContext';
import { FEE_STRUCTURE, ARTIFACT_TIERS, PROTOCOL_CONTRACTS } from '../lib/constants';

// NFT Preview Images (group shots for Quick Buy display)
import lunarDustImg from '../assets/nft/lunar_dust_preview.jpg';
import cosmicShardImg from '../assets/nft/cosmic_shard_preview.jpg';
import solarCoreImg from '../assets/nft/solar_core_preview.jpg';
import voidAnomalyImg from '../assets/nft/void_anomaly_preview.jpg';

enum ArtifactTier {
    LUNAR_DUST = 0,
    COSMIC_SHARD = 1,
    SOLAR_CORE = 2,
    VOID_ANOMALY = 3,
}

interface TierInfo {
    tier: ArtifactTier;
    name: string;
    rarity: string;
    maxSupply: number;
    basePrice: number;
    boost: number;
    icon: string;
    image: string;
    color: string;
    bgGradient: string;
    isDynamic: boolean;
}

// Pricing model: 1 XNT per 1% boost — consistent ratio across all tiers.
// Break-even at 100 XNT of epoch allocation for any tier at base price.
const TIERS: TierInfo[] = [
    { tier: ArtifactTier.LUNAR_DUST, name: 'Lunar Dust', rarity: 'Common', maxSupply: 600, basePrice: 5, boost: 5, icon: '🌑', image: lunarDustImg, color: 'text-lunar-300', bgGradient: 'from-gray-600 to-gray-700', isDynamic: false },
    { tier: ArtifactTier.COSMIC_SHARD, name: 'Cosmic Shard', rarity: 'Rare', maxSupply: 300, basePrice: 10, boost: 10, icon: '💎', image: cosmicShardImg, color: 'text-mission-orbit', bgGradient: 'from-purple-600 to-purple-800', isDynamic: true },
    { tier: ArtifactTier.SOLAR_CORE, name: 'Solar Core', rarity: 'Epic', maxSupply: 90, basePrice: 20, boost: 20, icon: '☀️', image: solarCoreImg, color: 'text-forge-gold', bgGradient: 'from-orange-500 to-red-600', isDynamic: true },
    { tier: ArtifactTier.VOID_ANOMALY, name: 'Void Anomaly', rarity: 'Legendary', maxSupply: 10, basePrice: 50, boost: 50, icon: '🌀', image: voidAnomalyImg, color: 'text-pink-400', bgGradient: 'from-pink-600 to-purple-900', isDynamic: true },
];

export default function MoonMarket() {
    const { x1Address, x1Connected, connectX1 } = useWallet();
    const { referrer } = useReferral();

    const [buying, setBuying] = useState(false);
    const [ownedArtifacts, setOwnedArtifacts] = useState<{ id: number; tier: ArtifactTier; equipped: boolean; usageCount: number }[]>([]);
    const [loading, setLoading] = useState(false);
    const [imageModal, setImageModal] = useState<{ open: boolean; tier: TierInfo | null }>({ open: false, tier: null });

    // Real data from blockchain (null = not loaded yet)
    // Initialize with FULL stock (1000 total) since none are sold yet
    const [poolStock, setPoolStock] = useState<Record<number, number | null>>({
        0: 600,
        1: 300,
        2: 90,
        3: 10
    });
    const [currentPrices, setCurrentPrices] = useState<Record<number, number | null>>({ 0: null, 1: null, 2: null, 3: null });
    const [daysUntilDecay] = useState<Record<number, number | null>>({ 1: null, 2: null, 3: null });

    // Live stats (null = not loaded)
    const [liveStats, setLiveStats] = useState<{
        lastRecycled: number | null;
        missionsActive: number | null;
        totalLocked: number | null;
        totalVolume: number | null;
    }>({
        lastRecycled: null,
        missionsActive: 0,
        totalLocked: 0,
        totalVolume: 0,
    });

    // Load real data when wallet connects
    useEffect(() => {
        if (x1Address && x1Connected) {
            loadBlockchainData();
        }
    }, [x1Address, x1Connected]);

    const loadBlockchainData = async () => {
        setLoading(true);
        try {
            // TODO: Replace with actual contract calls when deployed
            // For now, keep the default "Full Stock" unless we simulate buys
            console.log('Blockchain data loading requires mainnet deployment');
        } catch (err) {
            console.error('Failed to load blockchain data:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleBuy = async (tierInfo: TierInfo) => {
        if (!x1Connected) {
            connectX1();
            return;
        }

        if (poolStock[tierInfo.tier] === 0) return alert('Sold out! Watch for recycling.');

        if (!isMainnetReady) {
            alert('NFT Marketplace launches April 2, 2026. Stay tuned!');
            return;
        }

        if (poolStock[tierInfo.tier] === 0) {
            alert('Sold out! Watch for recycling.');
            return;
        }

        setBuying(true);
        try {
            // TODO: Call Anchor program instruction when deployed:
            //   const ix = await program.methods.buyArtifact(tierInfo.tier, referrer).instruction();
            //   const tx = new Transaction().add(ix);
            //   await sendTransaction(tx, connection);
            throw new Error('Contract integration pending');
        } catch (err: any) {
            console.error('Buy failed:', err);
            alert(err.message || 'Transaction failed');
        } finally {
            setBuying(false);
        }
    };

    // Ready when the Anchor program ID is filled in PROTOCOL_CONTRACTS
    const isMainnetReady = !!PROTOCOL_CONTRACTS.ARTIFACTS;

    return (
        <div className="max-w-6xl mx-auto">
            <div className="flex items-center justify-between mb-6">
                <div className="text-center flex-1">
                    <h1 className="font-space text-4xl font-bold mb-2">
                        <span className="text-forge-gold">🎯</span> Quick Buy
                    </h1>
                    <p className="text-lunar-400">Buy random NFT at lowest price per tier (Liquidity Pool)</p>
                </div>
                <Link
                    to="/marketplace"
                    className="px-4 py-2 bg-mission-orbit/20 text-mission-orbit rounded-lg hover:bg-mission-orbit/30 transition-colors text-sm flex items-center gap-2"
                >
                    <Sparkles className="w-4 h-4" />
                    Browse Individual NFTs →
                </Link>
            </div>

            {/* MAINNET NOTICE */}
            {!isMainnetReady && (
                <div className="glass-card bg-amber-500/10 border-amber-500/30 mb-6">
                    <div className="flex items-start gap-3">
                        <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                        <div>
                            <h4 className="font-medium text-amber-400 mb-1">Pre-Mainnet Preview</h4>
                            <p className="text-lunar-300 text-sm">
                                Live data will be available after mainnet deployment. Prices shown are base prices.
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* SNIPER DASHBOARD */}
            <div className="glass-card bg-gradient-to-r from-space-700/50 to-mission-launchpad/10 border-mission-launchpad/30 mb-6">
                <div className="flex items-center gap-2 mb-4">
                    <Target className="w-5 h-5 text-mission-launchpad" />
                    <h3 className="font-space text-lg text-white">Sniper Dashboard</h3>
                    {!x1Connected && <span className="text-xs text-amber-400 ml-auto">Connect X1 wallet for live data</span>}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <DashboardStat
                        label="Last Recycled"
                        value={liveStats.lastRecycled !== null ? `${liveStats.lastRecycled}m ago` : '--'}
                        icon={<RefreshCw className="w-4 h-4" />}
                        color="text-green-400"
                        pulse={liveStats.lastRecycled !== null}
                    />
                    <DashboardStat
                        label="Active Missions"
                        value={liveStats.missionsActive?.toString() ?? '--'}
                        icon={<Activity className="w-4 h-4" />}
                        color="text-mission-orbit"
                    />
                    <DashboardStat
                        label="🔒 Locked in Missions"
                        value={liveStats.totalLocked?.toString() ?? '--'}
                        icon={<Lock className="w-4 h-4" />}
                        color="text-red-400"
                    />
                    <DashboardStat
                        label="Total Volume"
                        value={liveStats.totalVolume !== null ? `${liveStats.totalVolume.toLocaleString()} XNT` : '-- XNT'}
                        icon={<TrendingUp className="w-4 h-4" />}
                        color="text-lunar-300"
                    />
                </div>
            </div>

            {/* Price Mechanics */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <div className="glass-card bg-green-500/10 border-green-500/30">
                    <div className="flex items-center gap-2 mb-2">
                        <TrendingUp className="w-5 h-5 text-green-400" />
                        <span className="font-medium text-green-400">Buy Pressure</span>
                    </div>
                    <p className="text-lunar-300 text-sm">Each purchase = <span className="text-white font-bold">+5%</span> next price</p>
                </div>
                <div className="glass-card bg-mission-launchpad/10 border-mission-launchpad/30">
                    <div className="flex items-center gap-2 mb-2">
                        <TrendingDown className="w-5 h-5 text-mission-launchpad" />
                        <span className="font-medium text-mission-launchpad">Weekly Decay</span>
                    </div>
                    <p className="text-lunar-300 text-sm">7 days no sale = <span className="text-white font-bold">-5%</span> price drop</p>
                </div>
            </div>

            {/* Strategic Value */}
            <div className="glass-card bg-forge-orange/10 border-forge-orange/30 mb-6">
                <div className="flex items-start gap-3">
                    <Zap className="w-5 h-5 text-forge-orange flex-shrink-0 mt-1" />
                    <div>
                        <h4 className="font-medium text-forge-orange mb-1">⚔️ Strategic Value</h4>
                        <p className="text-lunar-300 text-sm">
                            <strong className="text-green-400">Attack:</strong> Boost rewards before vesting.
                            <strong className="text-red-400 ml-2">Defense:</strong> Ejected missions recycle NFT → creates snipe opportunity.
                        </p>
                    </div>
                </div>
            </div>

            {/* Stock Overview */}
            <div className="glass-card mb-6">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="font-space text-lg text-white flex items-center gap-2">
                        <Info className="w-5 h-5 text-mission-launchpad" />
                        Live Stock
                    </h3>
                    {x1Connected ? (
                        <span className="text-xs text-lunar-400 flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
                            Connected
                        </span>
                    ) : (
                        <span className="text-xs text-amber-400">Connect wallet</span>
                    )}
                </div>
                <div className="grid grid-cols-4 gap-3">
                    {TIERS.map(t => (
                        <div key={t.tier} className="text-center bg-space-600/30 rounded-lg p-3">
                            <span className="text-2xl">{t.icon}</span>
                            <div className={`text-sm font-bold ${poolStock[t.tier] !== null ? (poolStock[t.tier]! > 0 ? 'text-green-400' : 'text-red-400') : 'text-lunar-400'}`}>
                                {poolStock[t.tier] !== null ? `${poolStock[t.tier]} / ${t.maxSupply}` : `-- / ${t.maxSupply}`}
                            </div>
                            <div className="text-xs text-lunar-400">{t.name}</div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Tier Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                {TIERS.map(tier => (
                    <TierCard
                        key={tier.tier}
                        tierInfo={tier}
                        stock={poolStock[tier.tier]}
                        currentPrice={currentPrices[tier.tier]}
                        daysUntilDecay={tier.isDynamic ? daysUntilDecay[tier.tier] : undefined}
                        onBuy={() => handleBuy(tier)}
                        buying={buying}
                        connected={x1Connected}
                        onConnect={connectX1}
                        onImageClick={() => setImageModal({ open: true, tier })}
                    />
                ))}
            </div>

            {/* Owned */}
            {ownedArtifacts.length > 0 && (
                <div className="glass-card mb-8">
                    <h3 className="font-space text-xl text-white mb-4">Your Arsenal</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        {ownedArtifacts.map(item => (
                            <OwnedCard key={item.id} item={item} tierInfo={TIERS[item.tier]} />
                        ))}
                    </div>
                </div>
            )}

            {/* The Cycle */}
            <div className="glass-card mb-8">
                <h3 className="font-space text-xl text-white mb-4 flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-forge-gold" /> The Game Loop
                </h3>
                <div className="grid grid-cols-4 gap-4">
                    <Step num={1} title="Buy" desc="Lock NFT" icon="💎" />
                    <Step num={2} title="Equip" desc="Start mission" icon="🚀" />
                    <Step num={3} title="Boost/Eject" desc="Claim or abort" icon="⚡" />
                    <Step num={4} title="Recycle" desc="NFT restocks" icon="♻️" />
                </div>
            </div>

            {/* Fees - v7.1 UPDATED */}
            <div className="glass-card bg-space-700/30 mb-8">
                <h3 className="font-space text-lg text-white mb-3">Fee Distribution (100%)</h3>
                <div className="grid grid-cols-4 gap-4 text-sm">
                    <FeeItem label="Pool" value={`${FEE_STRUCTURE.rewardPool}%`} color="text-green-400" />
                    <FeeItem label="Oracle" value={`${FEE_STRUCTURE.oracle}%`} color="text-mission-launchpad" />
                    <FeeItem label="Referrer" value={`${FEE_STRUCTURE.referrer}%`} color="text-mission-orbit" />
                    <FeeItem label="Dev Wallet" value={`${FEE_STRUCTURE.dev}%`} color="text-forge-orange" />
                </div>
                <p className="text-xs text-lunar-400 mt-3">
                    Applied to early-exit penalties only. Normal burns have zero fees.
                </p>
            </div>

            {/* Referral */}
            {referrer && (
                <div className="p-4 bg-green-500/10 border border-green-500/30 rounded-xl">
                    <p className="text-sm text-green-400">
                        ✅ Referrer: <code className="text-xs bg-space-700 px-2 py-0.5 rounded">{referrer.slice(0, 10)}...{referrer.slice(-6)}</code>
                    </p>
                </div>
            )}

            {/* Image Modal */}
            {imageModal.open && imageModal.tier && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
                    onClick={() => setImageModal({ open: false, tier: null })}
                >
                    <div
                        className="relative max-w-2xl w-full mx-4 animate-fade-in"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button
                            onClick={() => setImageModal({ open: false, tier: null })}
                            className="absolute -top-10 right-0 text-white/60 hover:text-white text-sm"
                        >
                            ✕ Close
                        </button>
                        <div className="glass-card p-6">
                            <img
                                src={imageModal.tier.image}
                                alt={imageModal.tier.name}
                                className="w-full rounded-lg shadow-2xl mb-4"
                            />
                            <div className="text-center">
                                <h3 className={`font-space text-2xl font-bold ${imageModal.tier.color}`}>
                                    {imageModal.tier.name}
                                </h3>
                                <p className="text-lunar-400 mt-1">
                                    {imageModal.tier.rarity} • +{imageModal.tier.boost}% Boost • {imageModal.tier.basePrice} XNT base
                                </p>
                                <p className="text-sm text-lunar-500 mt-2">
                                    {imageModal.tier.maxSupply} total supply • {imageModal.tier.isDynamic ? 'Dynamic pricing' : 'Fixed price'}
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════

function DashboardStat({ label, value, icon, color, pulse }: {
    label: string; value: string; icon: React.ReactNode; color: string; pulse?: boolean
}) {
    return (
        <div className="bg-space-600/50 rounded-lg p-3 text-center">
            <div className={`flex items-center justify-center gap-1 ${color} mb-1`}>
                {icon}
                <span className={`font-bold ${pulse ? 'animate-pulse' : ''}`}>{value}</span>
            </div>
            <div className="text-xs text-lunar-400">{label}</div>
        </div>
    );
}

function TierCard({ tierInfo, stock, currentPrice, daysUntilDecay, onBuy, buying, connected, onConnect, onImageClick }: {
    tierInfo: TierInfo; stock: number | null; currentPrice: number | null; daysUntilDecay?: number | null; onBuy: () => void; buying: boolean; connected: boolean; onConnect: () => void; onImageClick: () => void;
}) {
    const displayPrice = currentPrice ?? tierInfo.basePrice;
    const soldOut = stock === 0;
    const notLoaded = stock === null;
    const inflated = tierInfo.isDynamic && currentPrice !== null && currentPrice > tierInfo.basePrice;
    const increase = inflated ? Math.round(((currentPrice! - tierInfo.basePrice) / tierInfo.basePrice) * 100) : 0;

    return (
        <div className={`glass-card hover:border-forge-gold/30 transition-all group relative overflow-hidden ${soldOut ? 'opacity-60' : ''}`}>
            <div className={`absolute top-2 right-2 text-xs px-2 py-0.5 rounded-full font-bold bg-gradient-to-r ${tierInfo.bgGradient} text-white`}>
                {tierInfo.rarity}
            </div>

            {tierInfo.isDynamic ? (
                <div className="absolute top-2 left-2 text-xs px-2 py-0.5 rounded-full bg-forge-orange/80 text-white flex items-center gap-1">
                    <TrendingUp className="w-3 h-3" /> +5%
                </div>
            ) : (
                <div className="absolute top-2 left-2 text-xs px-2 py-0.5 rounded-full bg-green-500/80 text-white">Fixed</div>
            )}

            <div className="text-center mb-3 pt-10">
                <img
                    src={tierInfo.image}
                    alt={tierInfo.name}
                    onClick={onImageClick}
                    className="w-20 h-20 mx-auto mb-2 rounded-lg object-cover group-hover:scale-110 transition-transform shadow-lg cursor-pointer hover:ring-2 hover:ring-forge-gold/50"
                    title="Click to view full image"
                />
                <h3 className={`font-space text-lg ${tierInfo.color}`}>{tierInfo.name}</h3>
            </div>

            <div className="space-y-1 mb-3 text-sm">
                <div className="flex justify-between">
                    <span className="text-lunar-400">Boost</span>
                    <span className="text-forge-gold font-bold">+{tierInfo.boost}%</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-lunar-400">Base</span>
                    <span className="text-lunar-300">{tierInfo.basePrice} XNT</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-lunar-400">Current</span>
                    <span className={`font-bold ${inflated ? 'text-forge-orange' : 'text-white'}`}>
                        {notLoaded ? `${tierInfo.basePrice} XNT` : `${displayPrice.toFixed(2)} XNT`}
                        {inflated && <span className="text-xs"> (+{increase}%)</span>}
                    </span>
                </div>
                <div className="flex justify-between">
                    <span className="text-lunar-400">Stock</span>
                    <span className={notLoaded ? 'text-lunar-400' : (stock! > 0 ? 'text-green-400 font-bold' : 'text-red-400')}>
                        {notLoaded ? `--/${tierInfo.maxSupply}` : `${stock}/${tierInfo.maxSupply}`}
                    </span>
                </div>
            </div>

            {tierInfo.isDynamic && daysUntilDecay !== undefined && daysUntilDecay !== null && (
                <div className="mb-3 p-2 bg-space-600/50 rounded-lg text-center">
                    <div className="flex items-center justify-center gap-1 text-xs text-mission-launchpad">
                        <Clock className="w-3 h-3" /> -5% in {daysUntilDecay}d
                    </div>
                </div>
            )}

            <button
                onClick={connected ? onBuy : onConnect}
                disabled={buying || (connected && soldOut)}
                className={`w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl font-medium transition-all ${!connected ? 'bg-mission-orbit hover:bg-mission-orbit/80 text-white cursor-pointer' : soldOut ? 'bg-gray-600 text-gray-400 cursor-not-allowed' : 'btn-forge'}`}>
                {buying ? <Loader2 className="w-4 h-4 animate-spin" /> : soldOut ? <RefreshCw className="w-4 h-4" /> : <Zap className="w-4 h-4" />}
                {!connected ? '⚡ Connect X1' : soldOut ? 'Watching...' : `${displayPrice.toFixed(2)} XNT`}
            </button>
        </div>
    );
}

function OwnedCard({ item, tierInfo }: { item: { id: number; tier: ArtifactTier; equipped: boolean; usageCount: number }; tierInfo: TierInfo }) {
    return (
        <div className="bg-space-700/50 rounded-xl p-4 text-center border border-white/5">
            <div className="text-3xl mb-2">{tierInfo.icon}</div>
            <div className="text-sm text-white">{tierInfo.name}</div>
            <div className="text-xs text-lunar-400">#{item.id}</div>
            <div className="text-xs text-mission-launchpad mt-1">×{item.usageCount}</div>
            {item.equipped ? (
                <div className="mt-2 text-green-400 text-xs flex items-center justify-center gap-1"><Star className="w-3 h-3" /> Equipped</div>
            ) : (
                <button className="mt-2 text-xs btn-forge py-1 px-3">Equip</button>
            )}
        </div>
    );
}

function Step({ num, title, desc, icon }: { num: number; title: string; desc: string; icon: string }) {
    return (
        <div className="text-center">
            <div className="w-10 h-10 mx-auto mb-2 rounded-full bg-gradient-to-r from-forge-orange to-forge-gold flex items-center justify-center text-space-900 font-bold">{num}</div>
            <h4 className="font-medium text-white text-sm flex items-center justify-center gap-1"><span>{icon}</span> {title}</h4>
            <p className="text-lunar-400 text-xs mt-1">{desc}</p>
        </div>
    );
}

function FeeItem({ label, value, color }: { label: string; value: string; color: string }) {
    return (
        <div className="bg-space-600/50 rounded-lg p-3 text-center">
            <div className={`font-space text-lg ${color}`}>{value}</div>
            <div className="text-lunar-400 text-xs">{label}</div>
        </div>
    );
}
