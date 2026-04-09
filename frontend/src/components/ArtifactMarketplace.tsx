/**
 * Moon Forge - Artifact Marketplace v1.0
 * 
 * 🎯 INDIVIDUAL NFT MARKETPLACE 🎯
 * 
 * Browse and buy specific NFTs with their unique:
 * - Token ID
 * - Variant (color)
 * - Current dynamic price
 * - Days until next decay
 * - Usage history
 */

import { useState, useEffect } from 'react';
import { Filter, Grid, List, TrendingDown, Clock, Repeat, Sparkles, ShoppingCart, AlertTriangle, ChevronDown, Loader } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import { Link } from 'react-router-dom';
import { PROTOCOL_CONTRACTS } from '../lib/constants';

// Variant images - organized by tier/variant
const VARIANT_IMAGES: Record<string, string> = {
    // Lunar Dust
    'lunar_dust_frost_blue': new URL('../assets/nft/lunar_dust/frost_blue.jpg', import.meta.url).href,
    'lunar_dust_silver_moon': new URL('../assets/nft/lunar_dust/silver_moon.jpg', import.meta.url).href,
    'lunar_dust_golden_dust': new URL('../assets/nft/lunar_dust/golden_dust.jpg', import.meta.url).href,
    'lunar_dust_rose_quartz': new URL('../assets/nft/lunar_dust/rose_quartz.jpg', import.meta.url).href,
    'lunar_dust_sage_green': new URL('../assets/nft/lunar_dust/sage_green.jpg', import.meta.url).href,
    'lunar_dust_lavender_mist': new URL('../assets/nft/lunar_dust/lavender_mist.jpg', import.meta.url).href,
    // Cosmic Shard
    'cosmic_shard_amethyst': new URL('../assets/nft/cosmic_shard/amethyst.jpg', import.meta.url).href,
    'cosmic_shard_aquamarine': new URL('../assets/nft/cosmic_shard/aquamarine.jpg', import.meta.url).href,
    'cosmic_shard_magenta_pulse': new URL('../assets/nft/cosmic_shard/magenta_pulse.jpg', import.meta.url).href,
    // Solar Core
    'solar_core_flame': new URL('../assets/nft/solar_core/flame.jpg', import.meta.url).href,
    'solar_core_red_giant': new URL('../assets/nft/solar_core/red_giant.jpg', import.meta.url).href,
    // Void Anomaly
    'void_anomaly_event_horizon': new URL('../assets/nft/void_anomaly/event_horizon.jpg', import.meta.url).href,
};

// Map tokenId to variant
function getVariantKey(tokenId: number): string {
    // Lunar Dust variants
    if (tokenId >= 1 && tokenId <= 100) return 'lunar_dust_frost_blue';
    if (tokenId >= 101 && tokenId <= 200) return 'lunar_dust_silver_moon';
    if (tokenId >= 201 && tokenId <= 300) return 'lunar_dust_golden_dust';
    if (tokenId >= 301 && tokenId <= 400) return 'lunar_dust_rose_quartz';
    if (tokenId >= 401 && tokenId <= 500) return 'lunar_dust_sage_green';
    if (tokenId >= 501 && tokenId <= 600) return 'lunar_dust_lavender_mist';
    // Cosmic Shard variants
    if (tokenId >= 601 && tokenId <= 700) return 'cosmic_shard_amethyst';
    if (tokenId >= 701 && tokenId <= 800) return 'cosmic_shard_aquamarine';
    if (tokenId >= 801 && tokenId <= 900) return 'cosmic_shard_magenta_pulse';
    // Solar Core variants
    if (tokenId >= 901 && tokenId <= 945) return 'solar_core_flame';
    if (tokenId >= 946 && tokenId <= 990) return 'solar_core_red_giant';
    // Void Anomaly
    return 'void_anomaly_event_horizon';
}

function getVariantName(tokenId: number): string {
    const key = getVariantKey(tokenId);
    const parts = key.split('_');
    // Capitalize each word
    return parts.slice(2).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function getTierName(tokenId: number): string {
    if (tokenId <= 600) return 'Lunar Dust';
    if (tokenId <= 900) return 'Cosmic Shard';
    if (tokenId <= 990) return 'Solar Core';
    return 'Void Anomaly';
}

function getTierColor(tokenId: number): string {
    if (tokenId <= 600) return 'text-lunar-300';
    if (tokenId <= 900) return 'text-mission-orbit';
    if (tokenId <= 990) return 'text-forge-gold';
    return 'text-pink-400';
}

function getBoost(tokenId: number): number {
    if (tokenId <= 600) return 5;
    if (tokenId <= 900) return 10;
    if (tokenId <= 990) return 20;
    return 50;
}

// Pricing model: 1 XNT per 1% boost — consistent ratio across all tiers.
// Lunar Dust 5 XNT (+5%), Cosmic Shard 10 XNT (+10%), Solar Core 20 XNT (+20%), Void Anomaly 50 XNT (+50%)
function getBasePrice(tokenId: number): number {
    if (tokenId <= 600) return 5;   // Lunar Dust   +5%
    if (tokenId <= 900) return 10;  // Cosmic Shard +10%
    if (tokenId <= 990) return 20;  // Solar Core   +20%
    return 50;                      // Void Anomaly +50%
}

interface NFTListing {
    tokenId: number;
    currentPrice: number;
    lastSoldTime: number;
    usageCount: number;
    daysUntilDecay: number;
}

export default function ArtifactMarketplace() {
    const { x1Connected, connectX1 } = useWallet();

    const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
    const [tierFilter, setTierFilter] = useState<string>('all');
    const [sortBy, setSortBy] = useState<'price_asc' | 'price_desc' | 'tokenId' | 'decay' | 'usage'>('tokenId');

    // Listings come from contract reads — empty until deployed
    const [listings, setListings] = useState<NFTListing[]>([]);
    const [loadingNFTs, setLoadingNFTs] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    const [buying, setBuying] = useState<number | null>(null);
    const [showFilters, setShowFilters] = useState(false);

    const isContractDeployed = !!PROTOCOL_CONTRACTS.ARTIFACTS;

    // Load NFT listings from the Anchor program on X1 when contract is deployed
    useEffect(() => {
        if (!isContractDeployed) return;
        setLoadingNFTs(true);
        setLoadError(null);

        const load = async () => {
            try {
                // TODO: Replace with Anchor program reads when X1 program is deployed:
                //   const connection = new Connection(X1_RPC_URL);
                //   const program = new Program(IDL, PROTOCOL_CONTRACTS.ARTIFACTS, provider);
                //   const pools = await program.account.artifactPool.all();
                //   setListings(pools.map(p => ({ tokenId: p.account.tokenId, currentPrice: ..., ... })));
                setListings([]);
            } catch (err: any) {
                setLoadError(err.message || 'Failed to load NFTs');
            } finally {
                setLoadingNFTs(false);
            }
        };

        load();
    }, [isContractDeployed]);

    const filteredListings = listings
        .filter(l => {
            if (tierFilter === 'all') return true;
            const tier = getTierName(l.tokenId).toLowerCase().replace(' ', '_');
            return tier === tierFilter;
        })
        .sort((a, b) => {
            if (sortBy === 'price_asc') return a.currentPrice - b.currentPrice;
            if (sortBy === 'price_desc') return b.currentPrice - a.currentPrice;
            if (sortBy === 'tokenId') return a.tokenId - b.tokenId;
            if (sortBy === 'decay') return a.daysUntilDecay - b.daysUntilDecay;
            if (sortBy === 'usage') return b.usageCount - a.usageCount; // Most recycled first
            return 0;
        });

    const handleBuy = async (tokenId: number) => {
        if (!x1Connected) {
            connectX1();
            return;
        }
        if (!isContractDeployed) {
            alert('NFT Marketplace launches at mainnet. Stay tuned!');
            return;
        }
        setBuying(tokenId);
        try {
            // TODO: Call Anchor program instruction when deployed:
            //   const ix = await program.methods.buySpecificArtifact(tokenId, referrer).instruction();
            //   const tx = new Transaction().add(ix);
            //   await sendTransaction(tx, connection);
            throw new Error('Contract integration pending — connect after mainnet launch');
        } catch (err: any) {
            alert(err.message || 'Transaction failed');
        } finally {
            setBuying(null);
        }
    };

    return (
        <div className="p-4 md:p-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h2 className="font-space text-2xl font-bold text-white flex items-center gap-2">
                        <Sparkles className="w-6 h-6 text-forge-gold" />
                        Artifact Marketplace
                    </h2>
                    <p className="text-lunar-400 text-sm mt-1">
                        Browse and snipe specific NFTs with dynamic pricing
                    </p>
                </div>
                <Link
                    to="/nft"
                    className="px-4 py-2 bg-forge-orange/20 text-forge-orange rounded-lg hover:bg-forge-orange/30 transition-colors text-sm"
                >
                    ← Quick Buy
                </Link>
            </div>

            {/* Contract status notice */}
            {!isContractDeployed ? (
                <div className="glass-card bg-amber-500/10 border-amber-500/30 mb-6">
                    <div className="flex items-start gap-3">
                        <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                        <div>
                            <h4 className="font-medium text-amber-400">Launching April 2, 2026</h4>
                            <p className="text-lunar-300 text-sm">
                                NFT listings will be available live on the X1 network after mainnet launch.
                            </p>
                        </div>
                    </div>
                </div>
            ) : loadError ? (
                <div className="glass-card bg-red-500/10 border-red-500/30 mb-6">
                    <div className="flex items-start gap-3">
                        <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                        <p className="text-lunar-300 text-sm">{loadError}</p>
                    </div>
                </div>
            ) : null}

            {/* Filters Bar */}
            <div className="glass-card mb-6">
                <div className="flex flex-wrap items-center gap-3">
                    {/* Tier Filter */}
                    <div className="relative">
                        <button
                            onClick={() => setShowFilters(!showFilters)}
                            className="flex items-center gap-2 px-3 py-2 bg-space-600 rounded-lg text-sm hover:bg-space-500 transition-colors"
                        >
                            <Filter className="w-4 h-4" />
                            {tierFilter === 'all' ? 'All Tiers' : getTierName(tierFilter === 'lunar_dust' ? 1 : tierFilter === 'cosmic_shard' ? 601 : tierFilter === 'solar_core' ? 901 : 991)}
                            <ChevronDown className="w-4 h-4" />
                        </button>
                        {showFilters && (
                            <div className="absolute top-full left-0 mt-1 bg-space-700 rounded-lg shadow-xl z-50 min-w-[150px] border border-white/10">
                                {['all', 'lunar_dust', 'cosmic_shard', 'solar_core', 'void_anomaly'].map(tier => (
                                    <button
                                        key={tier}
                                        onClick={() => { setTierFilter(tier); setShowFilters(false); }}
                                        className={`w-full text-left px-3 py-2 hover:bg-space-600 text-sm ${tierFilter === tier ? 'text-forge-gold' : 'text-lunar-300'}`}
                                    >
                                        {tier === 'all' ? 'All Tiers' : tier.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Sort Options */}
                    <div className="flex items-center gap-1 bg-space-600 rounded-lg p-1 overflow-x-auto">
                        <button
                            onClick={() => setSortBy('tokenId')}
                            className={`px-3 py-1 rounded text-sm ${sortBy === 'tokenId' ? 'bg-forge-orange text-white' : 'text-lunar-400 hover:text-white'}`}
                        >
                            ID
                        </button>
                        <button
                            onClick={() => setSortBy('price_asc')}
                            className={`px-3 py-1 rounded text-sm ${sortBy === 'price_asc' ? 'bg-forge-orange text-white' : 'text-lunar-400 hover:text-white'}`}
                        >
                            Low Price
                        </button>
                        <button
                            onClick={() => setSortBy('price_desc')}
                            className={`px-3 py-1 rounded text-sm ${sortBy === 'price_desc' ? 'bg-forge-orange text-white' : 'text-lunar-400 hover:text-white'}`}
                        >
                            High Price
                        </button>
                        <button
                            onClick={() => setSortBy('usage')}
                            className={`px-3 py-1 rounded text-sm ${sortBy === 'usage' ? 'bg-forge-orange text-white' : 'text-lunar-400 hover:text-white'}`}
                        >
                            Recycled
                        </button>
                        <button
                            onClick={() => setSortBy('decay')}
                            className={`px-3 py-1 rounded text-sm ${sortBy === 'decay' ? 'bg-forge-orange text-white' : 'text-lunar-400 hover:text-white'}`}
                        >
                            Decay
                        </button>
                    </div>

                    {/* View Mode */}
                    <div className="ml-auto flex items-center gap-1">
                        <button
                            onClick={() => setViewMode('grid')}
                            className={`p-2 rounded ${viewMode === 'grid' ? 'bg-forge-orange text-white' : 'text-lunar-400 hover:text-white'}`}
                        >
                            <Grid className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => setViewMode('list')}
                            className={`p-2 rounded ${viewMode === 'list' ? 'bg-forge-orange text-white' : 'text-lunar-400 hover:text-white'}`}
                        >
                            <List className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Stats Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                <div className="glass-card text-center">
                    <div className="text-2xl font-bold text-white">{listings.length}</div>
                    <div className="text-xs text-lunar-400">Available NFTs</div>
                </div>
                <div className="glass-card text-center">
                    <div className="text-2xl font-bold text-green-400">
                        {listings.length > 0 ? `${Math.min(...listings.map(l => l.currentPrice)).toFixed(1)} XNT` : '--'}
                    </div>
                    <div className="text-xs text-lunar-400">Floor Price</div>
                </div>
                <div className="glass-card text-center">
                    <div className="text-2xl font-bold text-amber-400">
                        {listings.filter(l => l.daysUntilDecay <= 2).length}
                    </div>
                    <div className="text-xs text-lunar-400">Decaying Soon</div>
                </div>
                <div className="glass-card text-center">
                    <div className="text-2xl font-bold text-mission-orbit">
                        {listings.reduce((sum, l) => sum + l.usageCount, 0)}
                    </div>
                    <div className="text-xs text-lunar-400">Total Recycled</div>
                </div>
            </div>

            {/* NFT Grid */}
            <div className={viewMode === 'grid'
                ? 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4'
                : 'space-y-3'
            }>
                {filteredListings.map(nft => (
                    <NFTCard
                        key={nft.tokenId}
                        nft={nft}
                        viewMode={viewMode}
                        onBuy={handleBuy}
                        buying={buying === nft.tokenId}
                        connected={x1Connected}
                        onConnect={connectX1}
                    />
                ))}
            </div>

            {loadingNFTs && (
                <div className="flex items-center justify-center py-16 gap-3 text-lunar-400">
                    <Loader className="w-5 h-5 animate-spin" />
                    Loading NFT listings from chain...
                </div>
            )}

            {!loadingNFTs && !isContractDeployed && (
                <div className="text-center py-16">
                    <Sparkles className="w-12 h-12 text-forge-gold/40 mx-auto mb-4" />
                    <p className="text-lunar-400 text-lg font-medium">NFT Marketplace</p>
                    <p className="text-lunar-500 text-sm mt-1">
                        1,000 unique artifacts will be available on launch day.
                    </p>
                </div>
            )}

            {!loadingNFTs && isContractDeployed && filteredListings.length === 0 && !loadError && (
                <div className="text-center py-12 text-lunar-400">
                    No NFTs available with current filters
                </div>
            )}
        </div>
    );
}

function NFTCard({ nft, viewMode, onBuy, buying, connected, onConnect }: {
    nft: NFTListing;
    viewMode: 'grid' | 'list';
    onBuy: (tokenId: number) => void;
    buying: boolean;
    connected: boolean;
    onConnect: () => void;
}) {
    const variantKey = getVariantKey(nft.tokenId);
    const image = VARIANT_IMAGES[variantKey];
    const tierName = getTierName(nft.tokenId);
    const variantName = getVariantName(nft.tokenId);
    const tierColor = getTierColor(nft.tokenId);
    const boost = getBoost(nft.tokenId);
    const basePrice = getBasePrice(nft.tokenId);
    const isAboveBase = nft.currentPrice > basePrice;

    if (viewMode === 'list') {
        return (
            <div className="glass-card flex items-center gap-4">
                <img
                    src={image}
                    alt={`${tierName} #${nft.tokenId}`}
                    className="w-16 h-16 rounded-lg object-cover"
                />
                <div className="flex-1 min-w-0">
                    <div className="font-medium text-white">#{nft.tokenId} - {variantName}</div>
                    <div className={`text-sm ${tierColor}`}>{tierName} • +{boost}%</div>
                </div>
                <div className="text-right">
                    <div className={`font-bold ${isAboveBase ? 'text-amber-400' : 'text-green-400'}`}>
                        {nft.currentPrice.toFixed(2)} XNT
                    </div>
                    <div className="text-xs text-lunar-400 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {nft.daysUntilDecay}d decay
                    </div>
                </div>
                <button
                    onClick={() => connected ? onBuy(nft.tokenId) : onConnect()}
                    disabled={buying}
                    className={`px-4 py-2 rounded-lg font-medium hover:opacity-90 disabled:opacity-50 ${connected ? 'bg-gradient-to-r from-forge-orange to-forge-gold text-white' : 'bg-mission-orbit text-white'}`}
                >
                    {buying ? '...' : connected ? 'Buy' : '⚡ Connect'}
                </button>
            </div>
        );
    }

    return (
        <div className="glass-card group hover:border-forge-gold/30 transition-all overflow-hidden">
            {/* Image */}
            <div className="relative">
                <img
                    src={image}
                    alt={`${tierName} #${nft.tokenId}`}
                    className="w-full aspect-square object-cover rounded-lg"
                />
                <div className="absolute top-2 right-2 px-2 py-0.5 bg-black/60 rounded-full text-xs font-medium text-white">
                    #{nft.tokenId}
                </div>
                {nft.daysUntilDecay <= 2 && (
                    <div className="absolute top-2 left-2 px-2 py-0.5 bg-amber-500/80 rounded-full text-xs font-medium text-white flex items-center gap-1">
                        <TrendingDown className="w-3 h-3" />
                        {nft.daysUntilDecay}d
                    </div>
                )}
            </div>

            {/* Info */}
            <div className="p-3">
                <div className={`text-sm font-medium ${tierColor}`}>{tierName}</div>
                <div className="text-xs text-lunar-400 mb-2">{variantName}</div>

                <div className="flex items-center justify-between text-xs text-lunar-400 mb-2">
                    <span className="flex items-center gap-1">
                        <Sparkles className="w-3 h-3" />
                        +{boost}%
                    </span>
                    <span className="flex items-center gap-1">
                        <Repeat className="w-3 h-3" />
                        {nft.usageCount}×
                    </span>
                </div>

                <div className={`text-lg font-bold ${isAboveBase ? 'text-amber-400' : 'text-green-400'} mb-2`}>
                    {nft.currentPrice.toFixed(2)} XNT
                </div>

                <button
                    onClick={() => connected ? onBuy(nft.tokenId) : onConnect()}
                    disabled={buying}
                    className={`w-full py-2 rounded-lg font-medium hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2 ${connected ? 'bg-gradient-to-r from-forge-orange to-forge-gold text-white' : 'bg-mission-orbit text-white'}`}
                >
                    {buying ? (
                        <span className="animate-pulse">Buying...</span>
                    ) : connected ? (
                        <>
                            <ShoppingCart className="w-4 h-4" />
                            Buy Now
                        </>
                    ) : (
                        '⚡ Connect X1'
                    )}
                </button>
            </div>
        </div>
    );
}
