import { Shield, Zap, Info, Star, RefreshCw, Lock, Rocket, Users, ImageIcon, Code2, Gem } from 'lucide-react';
import { PROJECT_LINKS } from '../lib/constants';

// ─── DATA ─────────────────────────────────────────────────────────────────────

interface VariantRow {
    variant: string;
    idRange: string;
    count: number;
}

interface TierConfig {
    name: string;
    tierId: number;
    rarity: string;
    boost: string;
    floorPrice: string;
    pricing: 'Fixed' | 'Dynamic';
    supply: number;
    idRange: string;
    color: string;
    bg: string;
    border: string;
    description: string;
    variants: VariantRow[];
}

const ARTIFACT_TIERS: TierConfig[] = [
    {
        name: 'Lunar Dust',
        tierId: 0,
        rarity: 'Common',
        boost: '5%',
        floorPrice: '5 XNT',
        pricing: 'Fixed',
        supply: 600,
        idRange: '1 – 600',
        color: 'text-blue-400',
        bg: 'bg-blue-500/10',
        border: 'border-blue-500/20',
        description:
            'The most accessible artifact in the protocol. Fixed pricing ensures a stable entry point for new pilots. Locks to your mission until completion or early exit.',
        variants: [
            { variant: 'Frost Blue',    idRange: '1 – 100',   count: 100 },
            { variant: 'Silver Moon',   idRange: '101 – 200', count: 100 },
            { variant: 'Golden Dust',   idRange: '201 – 300', count: 100 },
            { variant: 'Rose Quartz',   idRange: '301 – 400', count: 100 },
            { variant: 'Sage Green',    idRange: '401 – 500', count: 100 },
            { variant: 'Lavender Mist', idRange: '501 – 600', count: 100 },
        ],
    },
    {
        name: 'Cosmic Shard',
        tierId: 1,
        rarity: 'Rare',
        boost: '10%',
        floorPrice: '10 XNT',
        pricing: 'Dynamic',
        supply: 300,
        idRange: '601 – 900',
        color: 'text-amber-400',
        bg: 'bg-amber-500/10',
        border: 'border-amber-500/20',
        description:
            'Fragments of cosmic material forged under dynamic market pressure. Each sale increases the price by 5%. Decays 4.76% per 7 days without demand.',
        variants: [
            { variant: 'Amethyst',     idRange: '601 – 700', count: 100 },
            { variant: 'Aquamarine',   idRange: '701 – 800', count: 100 },
            { variant: 'Magenta Pulse',idRange: '801 – 900', count: 100 },
        ],
    },
    {
        name: 'Solar Core',
        tierId: 2,
        rarity: 'Epic',
        boost: '20%',
        floorPrice: '20 XNT',
        pricing: 'Dynamic',
        supply: 90,
        idRange: '901 – 990',
        color: 'text-purple-400',
        bg: 'bg-purple-500/10',
        border: 'border-purple-500/20',
        description:
            'Only 90 exist. An epic-tier artifact demanding serious commitment. The solar crucible rewards those who hold longest.',
        variants: [
            { variant: 'Flame',    idRange: '901 – 945', count: 45 },
            { variant: 'Red Giant',idRange: '946 – 990', count: 45 },
        ],
    },
    {
        name: 'Void Anomaly',
        tierId: 3,
        rarity: 'Legendary',
        boost: '50%',
        floorPrice: '50 XNT',
        pricing: 'Dynamic',
        supply: 10,
        idRange: '991 – 1000',
        color: 'text-red-400',
        bg: 'bg-red-500/10',
        border: 'border-red-500/20',
        description:
            'Only 10 exist across the entire protocol. A 50% boost to Forge Score. Permanently verifiable on X1 — unmistakable and irreplaceable.',
        variants: [
            { variant: 'Event Horizon', idRange: '991 – 1000', count: 10 },
        ],
    },
];

// ─── COMPONENT ────────────────────────────────────────────────────────────────

export default function ArtifactsPage() {
    return (
        <div className="max-w-4xl mx-auto space-y-12 pb-16">

            {/* Header */}
            <section className="text-center py-8">
                <div className="flex items-center justify-center gap-3 mb-4">
                    <Star className="w-8 h-8 text-forge-gold" />
                    <h1 className="font-space text-4xl font-black text-white">Moon Forge Artifacts</h1>
                </div>
                <p className="text-lunar-400 max-w-2xl mx-auto">
                    A limited collection of 1,000 artifacts designed to amplify XEN burn rewards on X1.
                    Provably scarce, fully transparent, and permanently locked into the core protocol.
                </p>
                <div className="flex justify-center gap-4 mt-6 flex-wrap">
                    <span className="bg-space-800 border border-white/5 px-3 py-1 rounded-full text-xs text-lunar-300">Total Supply: 1,000</span>
                    <span className="bg-space-800 border border-white/5 px-3 py-1 rounded-full text-xs text-lunar-300">Standard: SPL-NFT (X1)</span>
                    <span className="bg-space-800 border border-white/5 px-3 py-1 rounded-full text-xs text-lunar-300">4 Tiers — 12 Variants</span>
                </div>
            </section>

            {/* Tier Cards */}
            <section className="space-y-6">
                <h2 className="font-space text-xl font-bold text-white">Tier Distribution</h2>
                {ARTIFACT_TIERS.map((tier) => (
                    <div key={tier.name} className={`glass-card border ${tier.border} ${tier.bg}`}>
                        {/* Tier Header */}
                        <div className="flex flex-wrap justify-between items-start gap-4 mb-4">
                            <div>
                                <div className="flex items-center gap-2 mb-1">
                                    <h3 className={`font-space text-xl font-bold ${tier.color}`}>{tier.name}</h3>
                                    <span className="text-xs text-lunar-500 uppercase tracking-widest border border-white/10 px-2 py-0.5 rounded-full">
                                        {tier.rarity}
                                    </span>
                                </div>
                                <p className="text-sm text-lunar-400 max-w-xl">{tier.description}</p>
                            </div>
                            <div className="flex gap-3 shrink-0">
                                <div className="text-center bg-black/40 px-3 py-2 rounded-lg border border-white/5">
                                    <div className="text-forge-gold font-bold text-lg">{tier.boost}</div>
                                    <div className="text-[10px] text-lunar-500">Boost</div>
                                </div>
                                <div className="text-center bg-black/40 px-3 py-2 rounded-lg border border-white/5">
                                    <div className="text-white font-bold text-lg">{tier.supply}</div>
                                    <div className="text-[10px] text-lunar-500">Supply</div>
                                </div>
                            </div>
                        </div>

                        {/* Tier Stats */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5 text-sm">
                            <div>
                                <span className="text-lunar-500 text-xs uppercase tracking-wide">Token IDs</span>
                                <p className="text-white font-mono">{tier.idRange}</p>
                            </div>
                            <div>
                                <span className="text-lunar-500 text-xs uppercase tracking-wide">Floor Price</span>
                                <p className="text-white font-mono">{tier.floorPrice}</p>
                            </div>
                            <div>
                                <span className="text-lunar-500 text-xs uppercase tracking-wide">Pricing</span>
                                <p className={tier.pricing === 'Fixed' ? 'text-green-400' : 'text-amber-400'}>{tier.pricing}</p>
                            </div>
                            <div>
                                <span className="text-lunar-500 text-xs uppercase tracking-wide">Tier ID</span>
                                <p className="text-white font-mono">{tier.tierId}</p>
                            </div>
                        </div>

                        {/* Variants Table */}
                        <div>
                            <p className="text-xs text-lunar-500 uppercase tracking-widest mb-2">Variants</p>
                            <div className="rounded-lg border border-white/5 overflow-hidden">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="bg-black/40 text-lunar-500 text-xs uppercase tracking-wider">
                                            <th className="text-left px-4 py-2">Variant</th>
                                            <th className="text-left px-4 py-2">Token IDs</th>
                                            <th className="text-right px-4 py-2">Count</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {tier.variants.map((v, i) => (
                                            <tr
                                                key={v.variant}
                                                className={`border-t border-white/5 ${i % 2 === 0 ? 'bg-black/10' : ''}`}
                                            >
                                                <td className={`px-4 py-2 font-medium ${tier.color}`}>{v.variant}</td>
                                                <td className="px-4 py-2 font-mono text-lunar-300">{v.idRange}</td>
                                                <td className="px-4 py-2 text-right text-lunar-400">{v.count}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                ))}
            </section>

            {/* Full Distribution Summary Table */}
            <section className="glass-card border border-white/10">
                <div className="flex items-center gap-3 mb-4">
                    <Zap className="w-5 h-5 text-forge-gold" />
                    <h2 className="font-space text-xl font-bold text-white">Complete Distribution — All 12 Variants</h2>
                </div>
                <div className="rounded-lg border border-white/5 overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="bg-black/40 text-lunar-500 text-xs uppercase tracking-wider">
                                <th className="text-left px-4 py-2">Tier</th>
                                <th className="text-left px-4 py-2">Rarity</th>
                                <th className="text-left px-4 py-2">Variant</th>
                                <th className="text-left px-4 py-2">Token IDs</th>
                                <th className="text-right px-4 py-2">Count</th>
                                <th className="text-right px-4 py-2">Boost</th>
                                <th className="text-right px-4 py-2">Floor</th>
                                <th className="text-right px-4 py-2">Pricing</th>
                            </tr>
                        </thead>
                        <tbody>
                            {ARTIFACT_TIERS.flatMap((tier) =>
                                tier.variants.map((v, i) => (
                                    <tr
                                        key={`${tier.name}-${v.variant}`}
                                        className="border-t border-white/5 hover:bg-white/2"
                                    >
                                        <td className={`px-4 py-2 font-medium ${tier.color}`}>
                                            {i === 0 ? tier.name : ''}
                                        </td>
                                        <td className="px-4 py-2 text-lunar-400">{i === 0 ? tier.rarity : ''}</td>
                                        <td className="px-4 py-2 text-lunar-200">{v.variant}</td>
                                        <td className="px-4 py-2 font-mono text-lunar-300">{v.idRange}</td>
                                        <td className="px-4 py-2 text-right text-lunar-400">{v.count}</td>
                                        <td className="px-4 py-2 text-right text-forge-gold font-bold">{tier.boost}</td>
                                        <td className="px-4 py-2 text-right text-lunar-300">{tier.floorPrice}</td>
                                        <td className={`px-4 py-2 text-right ${tier.pricing === 'Fixed' ? 'text-green-400' : 'text-amber-400'}`}>
                                            {tier.pricing}
                                        </td>
                                    </tr>
                                ))
                            )}
                            <tr className="border-t border-forge-gold/30 bg-forge-gold/5">
                                <td colSpan={4} className="px-4 py-2 font-bold text-white">Total</td>
                                <td className="px-4 py-2 text-right font-bold text-white">1,000</td>
                                <td colSpan={3} />
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>

            {/* Technical Transparency */}
            <section className="glass-card border border-forge-gold/20 bg-forge-gold/5">
                <div className="flex items-center gap-3 mb-6">
                    <Shield className="w-5 h-5 text-forge-gold" />
                    <h2 className="font-space text-xl font-bold text-white">Technical Transparency</h2>
                </div>

                <div className="space-y-6">
                    <div>
                        <h4 className="text-sm font-bold text-lunar-200 mb-2 flex items-center gap-2">
                            <RefreshCw className="w-4 h-4 text-blue-400" /> Dynamic Pricing Formula
                        </h4>
                        <p className="text-sm text-lunar-400 leading-relaxed">
                            Tiers 1–3 use dynamic pricing. Each sale increases the price of that tier by <strong>+5%</strong>.
                            For every 7 days without a sale, the price decays by <strong>-4.76% (1/1.05)</strong>, ensuring a
                            fair equilibrium. Tier 0 (Lunar Dust) uses a fixed floor price that never changes.
                        </p>
                    </div>

                    <div>
                        <h4 className="text-sm font-bold text-lunar-200 mb-2 flex items-center gap-2">
                            <Lock className="w-4 h-4 text-amber-400" /> Immutable Floor Prices
                        </h4>
                        <p className="text-sm text-lunar-400 leading-relaxed">
                            Hardcoded floor prices that can never be lowered:
                            Lunar Dust (5 XNT) · Cosmic Shard (10 XNT) · Solar Core (20 XNT) · Void Anomaly (50 XNT).
                        </p>
                    </div>

                    <div>
                        <h4 className="text-sm font-bold text-lunar-200 mb-2 flex items-center gap-2">
                            <Zap className="w-4 h-4 text-forge-gold" /> Mission Lock Mechanics
                        </h4>
                        <p className="text-sm text-lunar-400 leading-relaxed">
                            Artifacts equipped on a mission are locked for its duration. On completion the artifact is released.
                            On early exit (eject), the artifact is returned but the pilot pays the penalty fee. Artifacts
                            can be staked in duels via <code className="text-lunar-300">ArtifactDuel</code> — the loser forfeits
                            their artifact to the winner.
                        </p>
                    </div>

                    <div className="p-4 bg-black/40 rounded-lg border border-white/5">
                        <div className="flex items-start gap-3">
                            <Info className="w-5 h-5 text-forge-gold shrink-0 mt-0.5" />
                            <div>
                                <h5 className="text-xs font-bold text-forge-gold uppercase mb-1">On-Chain Metadata</h5>
                                <p className="text-xs text-lunar-500 leading-relaxed">
                                    All 1,000 metadata files are generated algorithmically and pinned to IPFS.
                                    The IPFS CID is locked inside <code className="text-lunar-300">MoonArtifacts</code> after
                                    <code className="text-lunar-300"> initializePool()</code> is called — permanently verifiable
                                    by anyone. Artwork, rarity, variant, and boost values cannot be altered post-lock.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* Phase 2 — Community Launch CTA */}
            <section className="glass-card border border-amber-500/30 bg-gradient-to-br from-amber-900/10 to-yellow-900/10">
                <div className="flex items-center gap-3 mb-2">
                    <Rocket className="w-6 h-6 text-amber-400" />
                    <h2 className="font-space text-xl font-bold text-white">Phase 2 — Community Launch</h2>
                    <span className="ml-auto bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider">
                        Coming Soon
                    </span>
                </div>
                <p className="text-lunar-400 text-sm mb-6 leading-relaxed">
                    NFT Artifacts are fully designed, specified, and ready — the on-chain infrastructure already exists
                    inside the Anchor program. Phase 2 launches when the community deploys the{' '}
                    <code className="text-amber-300">MoonArtifacts</code> Anchor program and mints the collection on X1.
                </p>

                {/* Steps needed */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
                    <div className="bg-black/30 border border-white/5 rounded-lg p-4 flex gap-3">
                        <Code2 className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm font-bold text-white mb-1">Deploy MoonArtifacts Anchor Program</p>
                            <p className="text-xs text-lunar-400">
                                Same process as the main Anchor deploy — one wallet, one command, ~2-3 XNT in rent.
                                The program code is open-source in the GitHub repo. Any trusted community member can do it.
                            </p>
                        </div>
                    </div>
                    <div className="bg-black/30 border border-white/5 rounded-lg p-4 flex gap-3">
                        <ImageIcon className="w-5 h-5 text-purple-400 shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm font-bold text-white mb-1">Artwork + Metadata on Arweave</p>
                            <p className="text-xs text-lunar-400">
                                12 variants across 4 tiers. Artist creates artwork, metadata is generated
                                algorithmically per spec, CID locked permanently on-chain at{' '}
                                <code className="text-lunar-300">initializePool()</code>. Cost: ~$10-30 on Arweave.
                            </p>
                        </div>
                    </div>
                    <div className="bg-black/30 border border-white/5 rounded-lg p-4 flex gap-3">
                        <Gem className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm font-bold text-white mb-1">Mint the 1,000-NFT Collection</p>
                            <p className="text-xs text-lunar-400">
                                All 1,000 token IDs, supplies, prices, and boost values are already defined in this
                                page. Minting via <code className="text-lunar-300">MoonArtifacts</code> — pilots buy
                                NFTs with XNT, 95.5% goes back to the reward pool.
                            </p>
                        </div>
                    </div>
                    <div className="bg-black/30 border border-white/5 rounded-lg p-4 flex gap-3">
                        <Users className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm font-bold text-white mb-1">Oracle Update (Zero Cost)</p>
                            <p className="text-xs text-lunar-400">
                                Once the program is deployed, the oracle reads NFT holders on-chain each epoch
                                and includes the boost in the Merkle leaf — automatically. No redeployment of
                                anything. Existing missions continue unaffected.
                            </p>
                        </div>
                    </div>
                </div>

                {/* Why it matters */}
                <div className="bg-black/20 border border-amber-500/20 rounded-lg p-5 mb-6">
                    <h4 className="text-sm font-bold text-amber-300 mb-3">Why NFT Artifacts matter for pilots</h4>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center text-sm">
                        <div>
                            <div className="text-2xl font-black text-blue-400">+5%</div>
                            <div className="text-xs text-lunar-400 mt-1">Lunar Dust<br/>600 available</div>
                        </div>
                        <div>
                            <div className="text-2xl font-black text-amber-400">+10%</div>
                            <div className="text-xs text-lunar-400 mt-1">Cosmic Shard<br/>300 available</div>
                        </div>
                        <div>
                            <div className="text-2xl font-black text-purple-400">+20%</div>
                            <div className="text-xs text-lunar-400 mt-1">Solar Core<br/>90 available</div>
                        </div>
                        <div>
                            <div className="text-2xl font-black text-red-400">+50%</div>
                            <div className="text-xs text-lunar-400 mt-1">Void Anomaly<br/>Only 10 exist</div>
                        </div>
                    </div>
                    <p className="text-xs text-lunar-500 mt-4 text-center">
                        Boost is applied to your Forge Score before epoch allocation — a 50% boost on a Moon Landing
                        mission with 10,000 XEN burned is an extra ~2,236 raw score points.
                    </p>
                </div>

                {/* Call to action */}
                <div className="flex flex-col sm:flex-row gap-3">
                    <a
                        href={`${PROJECT_LINKS.github}/issues`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 text-center py-3 px-5 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-300 font-bold rounded-lg transition-colors text-sm"
                    >
                        Volunteer to Deploy — Open an Issue on GitHub
                    </a>
                    <a
                        href={PROJECT_LINKS.github}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 text-center py-3 px-5 bg-white/5 hover:bg-white/10 border border-white/10 text-lunar-300 font-bold rounded-lg transition-colors text-sm"
                    >
                        Read the Deployment Guide
                    </a>
                </div>
                <p className="text-xs text-lunar-500 mt-3 text-center">
                    This is a fully permissionless protocol. No approval needed. Deploy it and it works.
                </p>
            </section>

            <section className="text-center italic text-lunar-500 text-xs">
                Artifact data is extracted directly from the protocol specification and metadata manifest.
                All 1,000 token IDs and their variants are deterministic and verifiable on-chain.
            </section>
        </div>
    );
}
