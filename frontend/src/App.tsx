/**
 * Moon Forge - Main Application
 * Any XEN, any chain → XNT on X1.
 */

import { lazy, Suspense } from 'react';
import { Routes, Route, Link } from 'react-router-dom';
import Header from './components/Header';
import TheForge from './components/TheForge';
import MissionControl from './components/MissionControl';
import SystemStatus from './components/SystemStatus';
import DonationPanel from './components/DonationPanel';
import { Notice, StatTile, Xnt } from './components/ui';
import { useProtocol } from './lib/hooks';
import { ARTIFACTS, FORGE_SPLIT, P } from './lib/protocol';
import { formatNumber } from './lib/constants';

const GamesPage = lazy(() => import('./pages/GamesPage'));
const ArtifactsPage = lazy(() => import('./pages/ArtifactsPage'));
const TransparencyPage = lazy(() => import('./pages/TransparencyPage'));
const WhitepaperPage = lazy(() => import('./pages/WhitepaperPage'));

function App() {
    return (
        <div className="min-h-screen relative z-10">
            <Header />

            <main className="container mx-auto px-4 py-8 pb-24">
                <Suspense fallback={<div className="text-center text-lunar-400 py-20">Loading…</div>}>
                    <Routes>
                        <Route path="/" element={<Home />} />
                        <Route path="/forge" element={<TheForge />} />
                        <Route path="/missions" element={<MissionControl />} />
                        <Route path="/artifacts" element={<ArtifactsPage />} />
                        <Route path="/nft" element={<ArtifactsPage />} />
                        <Route path="/marketplace" element={<ArtifactsPage />} />
                        <Route path="/games" element={<GamesPage />} />
                        <Route path="/donate" element={<DonationPage />} />
                        <Route path="/whitepaper" element={<WhitepaperPage />} />
                        <Route path="/transparency" element={<TransparencyPage />} />
                        <Route path="*" element={<Home />} />
                    </Routes>
                </Suspense>
            </main>

            <SystemStatus />
        </div>
    );
}

const num = (x: any): number | null => (x === null || x === undefined ? null : Number(x.toString()));

// ═══════════════════════════════════════════════════════════════════════════
//                              HOME PAGE
// ═══════════════════════════════════════════════════════════════════════════

function Home() {
    const { data, error } = useProtocol();
    const cfg = data?.config;
    const stats = cfg?.stats;
    const alive: number[] | null = cfg ? (cfg.artifactsAlive as number[]).map(Number) : null;
    const aliveTotal = alive ? alive.reduce((a, b) => a + b, 0) : null;
    const supplyTotal = ARTIFACTS.reduce((a, t) => a + t.supply, 0);

    return (
        <div className="max-w-6xl mx-auto">
            {/* Hero */}
            <section className="text-center py-14">
                <h1 className="font-space text-5xl md:text-7xl font-black mb-4">
                    <span className="bg-gradient-to-r from-forge-orange to-forge-gold bg-clip-text text-transparent">MOON FORGE</span>
                </h1>
                <p className="text-xl md:text-2xl text-lunar-200 mb-4">
                    Any XEN, any chain <span className="text-forge-gold">→ XNT on X1.</span>
                </p>
                <p className="text-lunar-400 max-w-2xl mx-auto mb-3">
                    Burn XEN on Ethereum, BSC, Polygon, Avalanche, Optimism, Base or PulseChain and receive XNT on X1,
                    with zero protocol fees on that path. XEN Prime is announced for Ethereum XEN only; Moon Forge is built for all seven chains.
                </p>
                <p className="text-lunar-500 text-sm max-w-2xl mx-auto mb-10">
                    Every epoch, score and payout is published and can be recomputed by anyone.
                </p>
                <div className="flex flex-col sm:flex-row gap-4 justify-center">
                    <Link to="/forge" className="btn-forge text-lg">Enter The Forge</Link>
                    <Link to="/missions" className="btn-outline text-lg">Claim XNT</Link>
                    <Link to="/artifacts" className="btn-outline text-lg">Artifacts</Link>
                </div>
            </section>

            <Notice kind="info" className="mb-6">
                Launch status: the X1 program v2 is live; portals are live on Base, Optimism, Polygon, BSC and Avalanche; PulseChain and Ethereum follow. Epochs are built weekly (Sundays 00:00 UTC). The figures below are read live from X1.
            </Notice>
            {error && <Notice kind="warn" className="mb-6">Could not read X1 right now ({error}). Values show "--" until the RPC answers.</Notice>}
            {data && !data.initialized && (
                <Notice kind="warn" className="mb-6">
                    The v2 program config is not initialized on X1 yet. Pools and stats below are read live and will fill in once it is.
                </Notice>
            )}

            {/* Reward pool */}
            <section className="py-6">
                <div className="glass-card border-2 border-forge-gold/50 glow-gold text-center p-8">
                    <p className="text-lunar-400 text-sm uppercase tracking-wider mb-2">Free reward pool (for burners)</p>
                    <div className="font-space text-5xl md:text-6xl font-black bg-gradient-to-r from-forge-orange to-forge-gold bg-clip-text text-transparent mb-3">
                        <Xnt lamports={data ? data.rewardFree : null} digits={2} />
                    </div>
                    <p className="text-lunar-300">
                        Max next epoch budget (10% of the free pool): <span className="text-forge-gold font-bold"><Xnt lamports={data ? data.nextEpochBudget : null} digits={2} /></span>
                    </p>
                    <p className="text-xs text-lunar-500 mt-1">
                        The actual budget can be lower: it is also capped at {P.rateCapK} × the liquidity-adjusted value burned × each burn's tier multiplier (Forge Drops included).
                    </p>
                    <p className="text-xs text-lunar-500 mt-2">
                        Filled by donations, 1% of house-game stakes, 1% of P2P pots and lottery tickets, {FORGE_SPLIT.poolPct}% of every Artifact forge, eject penalties,
                        unclaimed or expired epoch budgets, cancelled Forge Drops, expired lottery prizes, orphan-Artifact floors, the v1 sweep and the architect's cut
                        while its wallet is below rent exemption. Paid out only as epoch claims, Forge Drops and keeper tips.
                        Reserved for open epochs: <Xnt lamports={data ? data.rewardReserved : null} digits={2} />.
                    </p>
                </div>
            </section>

            {/* Live stats */}
            <section className="grid grid-cols-2 md:grid-cols-4 gap-4 py-6">
                <StatTile label="XNT paid to burners" value={<Xnt lamports={num(stats?.forgePaid)} digits={2} />} sub={`${stats ? formatNumber(num(stats.forgeClaims)!) : '--'} claims`} />
                <StatTile label="Last epoch" value={cfg ? `#${num(cfg.lastEpoch)}` : '--'} sub="Weekly (program minimum: 6 days apart)" />
                <StatTile label="Game bankroll (free)" value={<Xnt lamports={data ? data.bankrollFree : null} digits={2} />} sub={`Max net win per bet: ${data ? (data.maxNetWin / 1e9).toFixed(4) : '--'} XNT`} />
                <StatTile label="Burn Lottery vault" value={<Xnt lamports={data ? data.drawVault : null} digits={2} />} sub="Winner gets 50% per 7-day round" />
                <StatTile label="Artifacts alive" value={aliveTotal !== null ? `${aliveTotal} / ${supplyTotal}` : '--'} sub="Metaplex Core, recyclable" />
                <StatTile label="Wagered in house games" value={<Xnt lamports={num(stats?.wagered)} digits={2} />} sub={`${stats ? formatNumber(num(stats.bets)!) : '--'} bets`} />
                <StatTile label="Eject penalties to pool" value={<Xnt lamports={num(stats?.penaltiesToPool)} digits={2} />} sub="100% back to burners" />
                <StatTile label="Donated to reward pool" value={<Xnt lamports={num(stats?.donatedReward)} digits={2} />} sub={<Link to="/donate" className="text-forge-orange hover:underline">Donate</Link>} />
            </section>

            {/* Tiers */}
            <section className="py-10">
                <h2 className="font-space text-3xl text-center mb-2">Choose your <span className="text-forge-gold">mission</span></h2>
                <p className="text-center text-lunar-400 text-sm mb-8">The tier multiplies your score. Longer vesting = bigger share of each epoch.</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {P.tiers.map((t) => (
                        <div key={t.id} className={`glass-card ${t.id === 2 ? 'border-forge-gold glow-gold' : ''}`}>
                            <div className="flex items-center gap-3 mb-4">
                                <span className="text-3xl">{t.icon}</span>
                                <h3 className="font-space text-xl text-white">{t.name}</h3>
                                <span className="ml-auto font-space text-2xl text-forge-gold">{t.multiplier}×</span>
                            </div>
                            <div className="space-y-2 text-sm">
                                <div className="flex justify-between"><span className="text-lunar-400">Payout</span><span className="text-white">{t.vestingDays === 0 ? 'Instant at claim' : `Linear vesting, ${t.vestingDays} days`}</span></div>
                                <div className="flex justify-between"><span className="text-lunar-400">Eject penalty</span><span className={t.penaltyPct === 0 ? 'text-green-400' : 'text-red-400'}>{t.penaltyPct === 0 ? 'None' : `${t.penaltyPct}% of the unvested part`}</span></div>
                            </div>
                            <p className="text-xs text-lunar-500 mt-3">
                                {t.id === 0 && 'Paid straight to your X1 wallet when the claim lands.'}
                                {t.id === 1 && 'Vesting starts at claim; use "Withdraw vested" anytime. Ejecting at once pays 0.80× of the Launchpad equivalent in XNT (up to ~0.92× counting Forge Drops): always less than Launchpad.'}
                                {t.id === 2 && 'Vesting starts at claim; use "Withdraw vested" anytime. Ejecting at once pays 0.75× of the Launchpad equivalent in XNT (up to ~0.975× counting Forge Drops): always less than Launchpad.'}
                            </p>
                        </div>
                    ))}
                </div>
                <p className="text-center text-xs text-lunar-500 mt-4">Penalties go 100% back to the reward pool. Nobody else receives any part of them.</p>
            </section>

            {/* How it works */}
            <section className="py-10">
                <h2 className="font-space text-3xl text-center mb-8">How it <span className="text-forge-orange">works</span></h2>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                    <StepCard step={1} title="Burn XEN" description="On one of the 7 supported EVM chains, through MoonForgePortal v2 (live on Base, Optimism, Polygon, BSC and Avalanche; PulseChain and Ethereum to follow). The burn records your X1 address and tier." />
                    <StepCard step={2} title="Epoch on X1" description={`The oracle publishes a Merkle root weekly (the program requires ≥ ${P.minEpochIntervalDays} days between epochs). The program caps the budget at ${P.epochBudgetBps / 100}% of the free pool and at the epoch rate cap.`} />
                    <StepCard step={3} title="Claim" description={`Claims are permissionless. When the keeper is running it usually submits them for you (${P.keeperTip} XNT tip per claim of ≥ ${P.keeperTipMinClaim} XNT, paid by the pool, never by you). You can always claim yourself.`} />
                    <StepCard step={4} title="Receive XNT" description='Launchpad is paid at claim. Orbit / Moon Landing vest linearly from the claim; vested XNT is not pushed automatically: use "Withdraw vested" whenever you like.' />
                </div>
            </section>

            {/* Fees */}
            <section className="py-10">
                <div className="glass-card">
                    <h2 className="font-space text-2xl mb-4">Fees, in the open</h2>
                    <div className="grid md:grid-cols-2 gap-6 text-sm">
                        <div>
                            <p className="text-green-400 font-bold mb-2">Burn → XNT: 0% protocol fee</p>
                            <p className="text-lunar-400">No fee on burns, claims, vesting or withdrawals. Your payout is your share of the epoch budget.</p>
                        </div>
                        <div>
                            <p className="text-forge-gold font-bold mb-2">The architect earns only from optional activity:</p>
                            <ul className="text-lunar-400 space-y-1 list-disc list-inside">
                                <li>{P.edgeToArchitectPct}% of house-game stakes (part of the {P.houseEdgePct}% edge)</li>
                                <li>{P.rakeToArchitectPct}% of Jackpot / Duel / Moon Wars / Predictions pots when someone wins, and of every lottery ticket (part of the {P.p2pRakePct}% rake)</li>
                                <li>{FORGE_SPLIT.architectPct}% of each Artifact forge price, plus a 5% royalty on secondary sales where marketplaces honor it</li>
                                <li>Nothing from burns, claims or Forge Drops</li>
                            </ul>
                        </div>
                    </div>
                    <p className="text-xs text-lunar-500 mt-4">
                        See <Link to="/transparency" className="text-forge-orange hover:underline">Transparency</Link> for the live upgrade authority, oracle key and every split.
                    </p>
                </div>
            </section>
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

// ─── Donation Page ──────────────────────────────────────────────────────────
function DonationPage() {
    return (
        <div className="max-w-3xl mx-auto">
            <div className="text-center mb-8">
                <h1 className="font-space text-4xl font-black text-white mb-2">
                    Fuel the <span className="text-forge-gold">Forge</span>
                </h1>
                <p className="text-lunar-400">
                    Donations go 100% to the vault you choose, through the program's <code className="text-forge-orange">donate</code> instruction. No fee, no split.
                </p>
            </div>
            <DonationPanel />
        </div>
    );
}

export default App;
