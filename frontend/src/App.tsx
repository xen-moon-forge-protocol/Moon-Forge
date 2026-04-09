/**
 * Moon Forge - Main Application
 * 
 * "Don't wait for the party. Forge it."
 */

import { Routes, Route, Link } from 'react-router-dom';
import Header from './components/Header';
import TheForge from './components/TheForge';
import MissionControl from './components/MissionControl';
import MoonMarket from './components/MoonMarket';
import ArtifactMarketplace from './components/ArtifactMarketplace';
import SystemStatus from './components/SystemStatus';
import WhitepaperPage from './pages/WhitepaperPage';
import GamesPage from './pages/GamesPage';
import TransparencyPage from './pages/TransparencyPage';
import ArtifactsPage from './pages/ArtifactsPage';
import DonationPanel from './components/DonationPanel';

function App() {
    return (
        <div className="min-h-screen relative z-10">
            <Header />

            <main className="container mx-auto px-4 py-8">
                <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/forge" element={<TheForge />} />
                    <Route path="/missions" element={<MissionControl />} />
                    <Route path="/nft" element={<MoonMarket />} />
                    <Route path="/marketplace" element={<ArtifactMarketplace />} />
                    <Route path="/games" element={<GamesPage />} />
                    <Route path="/donate" element={<DonationPage />} />
                    <Route path="/whitepaper" element={<WhitepaperPage />} />
                    <Route path="/transparency" element={<TransparencyPage />} />
                    <Route path="/artifacts" element={<ArtifactsPage />} />
                </Routes>
            </main>

            {/* System Status Footer */}
            <SystemStatus />
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
//                              HOME PAGE
// ═══════════════════════════════════════════════════════════════════════════

function Home() {
    return (
        <div className="max-w-6xl mx-auto">
            {/* Hero Section */}
            <section className="text-center py-16">
                <h1 className="font-space text-5xl md:text-7xl font-black mb-4">
                    <span className="bg-gradient-to-r from-forge-orange to-forge-gold bg-clip-text text-transparent">
                        MOON FORGE
                    </span>
                </h1>
                <p className="text-xl md:text-2xl text-lunar-300 mb-8">
                    Don't wait for the party. <span className="text-forge-gold">Forge it.</span>
                </p>
                <p className="text-lunar-400 max-w-2xl mx-auto mb-12">
                    The unofficial Moon Party is here. Burn your XEN tokens on <span className="text-white font-semibold">Ethereum, Optimism, BSC, Polygon, or Avalanche</span>
                    {' '}and earn XNT rewards on the X1 blockchain. Up to <span className="text-forge-orange font-bold">3x multiplier</span>
                    {' '}for long-term holders.
                </p>

                <div className="flex flex-col sm:flex-row gap-4 justify-center">
                    <Link to="/forge" className="btn-forge text-lg">
                        Enter The Forge
                    </Link>
                    <Link to="/nft" className="btn-outline text-lg">
                        Get Artifacts
                    </Link>
                </div>
            </section>

            {/* XNT Pool Highlight - MAIN ATTRACTION */}
            <section className="py-8">
                <div className="glass-card border-2 border-forge-gold/50 glow-gold text-center p-8">
                    <p className="text-lunar-400 text-sm uppercase tracking-wider mb-2">Available in Reward Pool</p>
                    <div className="font-space text-5xl md:text-7xl font-black bg-gradient-to-r from-forge-orange to-forge-gold bg-clip-text text-transparent mb-2">
                        -- XNT
                    </div>
                    <p className="text-lunar-400 text-sm">
                        Pool fills from NFT sales (95.5% of each purchase)
                    </p>
                    <p className="text-xs text-lunar-500 mt-2">
                        💡 The more you burn, the bigger your share of this pool
                    </p>
                </div>
            </section>

            {/* Stats Section */}
            <section className="grid grid-cols-1 md:grid-cols-3 gap-6 py-8">
                <StatCard
                    label="Total XEN Burned"
                    value="--"
                    suffix="XEN"
                    icon="🔥"
                />
                <StatCard
                    label="Active Missions"
                    value="--"
                    suffix="Pilots"
                    icon="🚀"
                />
                <StatCard
                    label="XNT Distributed"
                    value="--"
                    suffix="XNT"
                    icon="🌙"
                />
            </section>

            {/* Tiers Preview */}
            <section className="py-12">
                <h2 className="font-space text-3xl text-center mb-8">
                    Choose Your <span className="text-forge-gold">Mission</span>
                </h2>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <TierPreview
                        name="Launchpad"
                        duration="5 Days"
                        bonus="1.0x"
                        penalty="0%"
                        color="mission-launchpad"
                        icon="🚀"
                        description="Quick mission. No penalty for early exit."
                    />
                    <TierPreview
                        name="Orbit"
                        duration="45 Days"
                        bonus="2.0x"
                        penalty="20%"
                        color="mission-orbit"
                        icon="🛸"
                        description="2x multiplier on rewards. 20% penalty if you exit early."
                    />
                    <TierPreview
                        name="Moon Landing"
                        duration="180 Days"
                        bonus="3.0x"
                        penalty="50%"
                        color="mission-moon"
                        icon="🌙"
                        description="Maximum 3x multiplier. 50% penalty if you exit early."
                        featured
                    />
                </div>
            </section>

            {/* How It Works */}
            <section className="py-12">
                <h2 className="font-space text-3xl text-center mb-8">
                    How It <span className="text-forge-orange">Works</span>
                </h2>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                    <StepCard step={1} title="Connect Wallet" description="Link your MetaMask (for XEN) and X1 Wallet (for XNT)." />
                    <StepCard step={2} title="Burn XEN" description="Choose your mission tier and burn XEN tokens." />
                    <StepCard step={3} title="Wait & Earn" description="Your rewards vest over time. Patience pays." />
                    <StepCard step={4} title="Claim XNT" description="Collect your XNT rewards on the X1 blockchain." />
                </div>
            </section>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
//                              SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════

function StatCard({ label, value, suffix, icon }: { label: string; value: string; suffix: string; icon: string }) {
    return (
        <div className="glass-card text-center">
            <div className="text-4xl mb-2">{icon}</div>
            <div className="font-space text-3xl text-forge-gold">{value}</div>
            <div className="text-lunar-400 text-sm">{suffix}</div>
            <div className="text-lunar-300 mt-2">{label}</div>
        </div>
    );
}

function TierPreview({
    name, duration, bonus, penalty, color, icon, description, featured
}: {
    name: string;
    duration: string;
    bonus: string;
    penalty: string;
    color: string;
    icon: string;
    description: string;
    featured?: boolean;
}) {
    return (
        <div className={`glass-card ${featured ? 'border-forge-gold glow-gold' : ''}`}>
            <div className="flex items-center gap-3 mb-4">
                <span className="text-3xl">{icon}</span>
                <h3 className={`font-space text-xl text-${color}`}>{name}</h3>
                {featured && <span className="ml-auto bg-forge-gold text-space-900 px-2 py-1 text-xs rounded-full font-bold">BEST</span>}
            </div>
            <p className="text-lunar-400 text-sm mb-4">{description}</p>
            <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                    <span className="text-lunar-400">Duration</span>
                    <span className="text-white">{duration}</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-lunar-400">Bonus</span>
                    <span className="text-forge-gold font-bold">{bonus}</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-lunar-400">Early Exit Penalty</span>
                    <span className={penalty === '0%' ? 'text-green-400' : 'text-red-400'}>{penalty}</span>
                </div>
            </div>
        </div>
    );
}

// ─── Donation Page wrapper ──────────────────────────────────────────────────
function DonationPage() {
    return (
        <div className="max-w-2xl mx-auto">
            <div className="text-center mb-8">
                <h1 className="font-space text-4xl font-black text-white mb-2">
                    Fuel the <span className="text-forge-gold">Forge</span>
                </h1>
                <p className="text-lunar-400">
                    100% of every donation goes directly to the XNT reward pool.
                    No fees. No splits. Proven on-chain.
                </p>
            </div>
            <DonationPanel />
        </div>
    );
}

function StepCard({ step, title, description }: { step: number; title: string; description: string }) {
    return (
        <div className="glass-card text-center">
            <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-gradient-to-r from-forge-orange to-forge-gold flex items-center justify-center text-space-900 font-bold text-xl">
                {step}
            </div>
            <h3 className="font-space text-lg text-white mb-2">{title}</h3>
            <p className="text-lunar-400 text-sm">{description}</p>
        </div>
    );
}

export default App;
