import React, { useState, useMemo } from 'react';
import {
    Calculator, TrendingUp, TrendingDown, AlertTriangle, DollarSign, Info,
    Zap, CheckCircle, XCircle, Lightbulb, Globe, Lock, Shield, Star,
    ArrowRight, ChevronDown, ChevronUp,
} from 'lucide-react';
import { CWF_DEFAULTS } from '../lib/constants';

interface ROICalculatorProps {
    poolBalance?: number;   // XNT in pool
    totalVesting?: number;  // XNT committed to vesting
    xntPrice?: number;      // Current XNT price USD
}

// ─── Static config ────────────────────────────────────────────────────────────

const TIERS = [
    { id: 0, name: 'Launchpad',    days: 5,   multiplier: 1.0, penalty: 0,  color: 'text-blue-400',   border: 'border-blue-500' },
    { id: 1, name: 'Orbit',        days: 45,  multiplier: 2.0, penalty: 20, color: 'text-amber-400',  border: 'border-amber-500' },
    { id: 2, name: 'Moon Landing', days: 180, multiplier: 3.0, penalty: 50, color: 'text-purple-400', border: 'border-purple-500' },
] as const;

const CHAINS = [
    { key: 'ethereum',  label: 'Ethereum',  token: 'XEN',   cwfKey: 1   },
    { key: 'optimism',  label: 'Optimism',  token: 'opXEN', cwfKey: 10  },
    { key: 'avalanche', label: 'Avalanche', token: 'aXEN',  cwfKey: 43114 },
    { key: 'bsc',       label: 'BNB Chain', token: 'bXEN',  cwfKey: 56  },
    { key: 'polygon',   label: 'Polygon',   token: 'mXEN',  cwfKey: 137 },
];

const ARTIFACTS = [
    { name: 'None',         boost: 0,  price: 0,  label: 'No Artifact' },
    { name: 'Lunar Dust',   boost: 5,  price: 5,  label: 'Lunar Dust   +5%  · 5 XNT' },
    { name: 'Cosmic Shard', boost: 10, price: 10, label: 'Cosmic Shard +10% · 10 XNT' },
    { name: 'Solar Core',   boost: 20, price: 20, label: 'Solar Core   +20% · 20 XNT' },
    { name: 'Void Anomaly', boost: 50, price: 50, label: 'Void Anomaly +50% · 50 XNT' },
] as const;

// ─── Score formula ─────────────────────────────────────────────────────────────

function forgeScore(amount: number, cwf: number, tierMult: number, artifactBoost: number) {
    const xenNorm  = amount * cwf;
    const raw      = Math.sqrt(xenNorm);
    const tiered   = raw * tierMult;
    const boosted  = tiered * (1 + artifactBoost / 100);
    return { xenNorm, raw, tiered, boosted };
}

// ─── Forge Advisor tip engine ─────────────────────────────────────────────────

type TipKind = 'chain' | 'tier' | 'nft' | 'strategy' | 'risk';
interface Tip {
    kind: TipKind;
    icon: React.ReactNode;
    label: string;
    text: string;
    action?: string;       // CTA label
    actionFn?: () => void; // CTA callback
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ROICalculator({
    poolBalance  = 0,
    totalVesting = 0,
    xntPrice     = 0.001,
}: ROICalculatorProps) {
    const [xenAmount,          setXenAmount]          = useState<string>('1000000');
    const [selectedChainKey,   setSelectedChainKey]   = useState<string>('ethereum');
    const [selectedTierId,     setSelectedTierId]     = useState<number>(1);
    const [artifactBoost,      setArtifactBoost]      = useState<number>(0);
    const [expectedAllocation, setExpectedAllocation] = useState<string>('');
    const [showMaxPotential,   setShowMaxPotential]   = useState<boolean>(false);

    // Derived primitives
    const amount   = parseFloat(xenAmount) || 0;
    const chain    = CHAINS.find(c => c.key === selectedChainKey) ?? CHAINS[0];
    const cwf      = CWF_DEFAULTS[chain.cwfKey] ?? 1.0;
    const tier     = TIERS[selectedTierId];
    const artifact = ARTIFACTS.find(a => a.boost === artifactBoost) ?? ARTIFACTS[0];

    // Primary score
    const score = useMemo(() => forgeScore(amount, cwf, tier.multiplier, artifactBoost), [amount, cwf, tier, artifactBoost]);

    // All-tier comparison (same chain, same amount, same NFT)
    const tierComparison = useMemo(() =>
        TIERS.map(t => ({ ...t, score: forgeScore(amount, cwf, t.multiplier, artifactBoost) })),
    [amount, cwf, artifactBoost]);

    // Artifact break-even
    const artifactPrice    = artifact.price;
    const breakEvenAlloc   = artifactBoost > 0 ? (artifactPrice * 100) / artifactBoost : 0;
    const userAlloc        = parseFloat(expectedAllocation) || 0;
    const nftExtra         = userAlloc * (artifactBoost / 100);
    const nftNet           = nftExtra - artifactPrice;
    const hasAllocInput    = userAlloc > 0 && artifactBoost > 0;

    // Pool health
    const solvencyRatio = totalVesting > 0 ? (poolBalance / totalVesting) * 100 : 100;

    // Max potential (ETH + Moon Landing + Void Anomaly)
    const maxPotential = useMemo(() => forgeScore(amount, 1.0, 3.0, 50), [amount]);

    // ── Forge Advisor ──────────────────────────────────────────────────────────
    const tips: Tip[] = useMemo(() => {
        const out: Tip[] = [];

        // 1. Chain efficiency
        if (cwf < 0.1) {
            const ethEquiv = (amount * cwf).toLocaleString(undefined, { maximumFractionDigits: 0 });
            out.push({
                kind: 'chain',
                icon: <Globe className="w-4 h-4 text-red-400" />,
                label: 'Low CWF Chain',
                text: `${chain.label} has a CWF of ${cwf.toFixed(3)}×. Your ${amount.toLocaleString()} ${chain.token} is worth approximately ${ethEquiv} XEN on Ethereum. For the same score, you would only need ${ethEquiv} XEN on ETH.`,
                action: 'Switch to Ethereum',
                actionFn: () => setSelectedChainKey('ethereum'),
            });
        } else if (cwf < 0.5) {
            out.push({
                kind: 'chain',
                icon: <Globe className="w-4 h-4 text-amber-400" />,
                label: 'Moderate CWF',
                text: `${chain.label} (CWF ${cwf.toFixed(3)}×) multiplies your burned XEN by ${cwf.toFixed(3)} before the formula. Ethereum or Optimism would yield the same score with significantly fewer tokens.`,
            });
        } else {
            out.push({
                kind: 'chain',
                icon: <Globe className="w-4 h-4 text-green-400" />,
                label: 'Excellent Chain Choice',
                text: `${chain.label} has one of the highest CWFs available (${cwf.toFixed(3)}×). Each token burned here counts as much as possible towards your score.`,
            });
        }

        // 2. Tier upgrade advice
        if (selectedTierId === 0) {
            const moonScore = forgeScore(amount, cwf, 3.0, artifactBoost).boosted;
            const gain      = ((moonScore / score.boosted - 1) * 100).toFixed(0);
            out.push({
                kind: 'tier',
                icon: <Lock className="w-4 h-4 text-blue-400" />,
                label: 'Tier Upgrade Available',
                text: `Orbit (45 days) would double your score to ${(score.raw * 2.0).toFixed(2)} pts (+100%). Moon Landing (180 days) would triple it to ${moonScore.toFixed(2)} pts (+${gain}%). No early exit penalty in Launchpad — try it before committing more time.`,
                action: 'Simulate Orbit',
                actionFn: () => setSelectedTierId(1),
            });
        } else if (selectedTierId === 1) {
            const moonScore = score.raw * 3.0 * (1 + artifactBoost / 100);
            const extra     = (moonScore - score.boosted).toFixed(2);
            out.push({
                kind: 'tier',
                icon: <Lock className="w-4 h-4 text-amber-400" />,
                label: 'Moon Landing: +50% Score',
                text: `Switching to Moon Landing (180 days) would add +${extra} pts to your score (+50%). The early exit penalty increases from 20% to 50% — only do this if you are sure about the 180 days.`,
                action: 'Simulate Moon Landing',
                actionFn: () => setSelectedTierId(2),
            });
        } else {
            out.push({
                kind: 'tier',
                icon: <Lock className="w-4 h-4 text-purple-400" />,
                label: 'Maximum Multiplier Active',
                text: `Moon Landing 3× is the highest multiplier available. Your score is maximized on this dimension. Remember: 50% penalty if you exit before 180 days.`,
            });
        }

        // 3. NFT advice
        if (artifactBoost === 0 && amount > 0) {
            out.push({
                kind: 'nft',
                icon: <Star className="w-4 h-4 text-purple-400" />,
                label: 'Artifact Available',
                text: `No Artifact. If your epoch allocation is ≥ 100 XNT, any Artifact at base price is profitable (ratio 1 XNT per 1% boost). Lunar Dust (5 XNT, +5%) is enough for epochs with allocation above 100 XNT.`,
                action: 'Simulate Lunar Dust',
                actionFn: () => setArtifactBoost(5),
            });
        } else if (artifactBoost > 0 && artifactBoost < 50 && selectedTierId === 2) {
            out.push({
                kind: 'nft',
                icon: <Star className="w-4 h-4 text-purple-400" />,
                label: 'Void Anomaly on Moon Landing',
                text: `On Moon Landing, the Void Anomaly (+50%) is highly recommended: 50 XNT cost with +50% boost. For allocations above 100 XNT, the net return is the highest among all Artifacts.`,
                action: 'Simulate Void Anomaly',
                actionFn: () => setArtifactBoost(50),
            });
        }

        // 4. Risk warning for Moon Landing with low-CWF chain
        if (selectedTierId === 2 && cwf < 0.1) {
            out.push({
                kind: 'risk',
                icon: <AlertTriangle className="w-4 h-4 text-red-400" />,
                label: 'Warning: Low CWF + High Tier',
                text: `Moon Landing with ${chain.label} (CWF ${cwf.toFixed(3)}×) generates a low score but locks your tokens for 180 days with a 50% exit penalty. Consider a chain with a higher CWF to justify the long lock.`,
            });
        }

        // 5. Pool health tip
        if (poolBalance > 0 && solvencyRatio >= 150) {
            out.push({
                kind: 'strategy',
                icon: <Shield className="w-4 h-4 text-green-400" />,
                label: 'Healthy Pool — Good Timing',
                text: `The pool is healthy (${solvencyRatio.toFixed(0)}% coverage). Epochs with a robust pool mean higher allocations for all pilots. Favorable timing for larger burns and long tiers.`,
            });
        } else if (poolBalance > 0 && solvencyRatio < 100) {
            out.push({
                kind: 'risk',
                icon: <AlertTriangle className="w-4 h-4 text-red-400" />,
                label: 'Low Pool Coverage',
                text: `Pool is at ${solvencyRatio.toFixed(0)}% coverage. Allocations per epoch will be lower. Consider waiting for the pool to recover (donations, new games, penalties returning) before making a long lock.`,
            });
        }

        return out;
    }, [cwf, chain, amount, selectedTierId, artifactBoost, score, solvencyRatio, poolBalance]);

    // ── Render ─────────────────────────────────────────────────────────────────
    const tipKindColor: Record<TipKind, string> = {
        chain:    'border-blue-500/30 bg-blue-500/5',
        tier:     'border-amber-500/30 bg-amber-500/5',
        nft:      'border-purple-500/30 bg-purple-500/5',
        strategy: 'border-green-500/30 bg-green-500/5',
        risk:     'border-red-500/30 bg-red-500/5',
    };

    return (
        <div className="glass-card p-6 rounded-xl border border-amber-500/20 space-y-6">

            {/* Header */}
            <div className="flex items-center gap-3">
                <Calculator className="w-6 h-6 text-amber-400" />
                <h2 className="text-xl font-bold text-amber-400">Forge Score Calculator</h2>
                <span className="ml-auto text-xs text-gray-500 bg-black/40 px-2 py-1 rounded">v12.0</span>
            </div>

            {/* ── INPUTS ─────────────────────────────────────────────────── */}
            <div className="space-y-4">

                {/* Chain */}
                <div>
                    <label className="block text-sm text-gray-400 mb-1">Source Chain</label>
                    <select
                        value={selectedChainKey}
                        onChange={e => setSelectedChainKey(e.target.value)}
                        className="w-full bg-black/50 border border-amber-500/30 rounded-lg px-4 py-3 text-white focus:border-amber-500 focus:outline-none text-sm"
                    >
                        {CHAINS.map(c => (
                            <option key={c.key} value={c.key}>
                                {c.label} ({c.token}) — CWF {(CWF_DEFAULTS[c.cwfKey] ?? 1).toFixed(3)}×
                            </option>
                        ))}
                    </select>
                    <p className="text-xs text-gray-600 mt-1">
                        CWF = Chain Weight Factor. ETH = 1.000 (anchor). Lower CWF → more tokens for the same score.
                    </p>
                </div>

                {/* Amount */}
                <div>
                    <label className="block text-sm text-gray-400 mb-1">
                        {chain.token} to Burn
                    </label>
                    <div className="relative">
                        <input
                            type="number"
                            value={xenAmount}
                            onChange={e => setXenAmount(e.target.value)}
                            className="w-full bg-black/50 border border-amber-500/30 rounded-lg px-4 py-3 text-white focus:border-amber-500 focus:outline-none text-sm"
                            placeholder="1,000,000"
                        />
                        <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 text-sm">{chain.token}</span>
                    </div>
                    <p className="text-xs text-gray-600 mt-1">
                        Normalized: {score.xenNorm.toFixed(2)} XEN_norm (amount × CWF {cwf.toFixed(3)}) → √{score.xenNorm.toFixed(2)} = {score.raw.toFixed(4)} base pts
                    </p>
                </div>

                {/* Tier */}
                <div>
                    <label className="block text-sm text-gray-400 mb-1">Mission Tier</label>
                    <div className="grid grid-cols-3 gap-2">
                        {TIERS.map(t => (
                            <button
                                key={t.id}
                                onClick={() => setSelectedTierId(t.id)}
                                className={`p-3 rounded-lg border transition-all text-left ${
                                    selectedTierId === t.id
                                        ? `${t.border} bg-black/60 ${t.color}`
                                        : 'border-gray-700 bg-black/30 text-gray-400 hover:border-gray-600'
                                }`}
                            >
                                <div className="text-xs font-bold">{t.name}</div>
                                <div className="text-xs text-gray-500">{t.days}d lock</div>
                                <div className={`text-sm font-bold ${selectedTierId === t.id ? t.color : 'text-gray-400'}`}>{t.multiplier}×</div>
                                {t.penalty > 0 && (
                                    <div className="text-xs text-red-500">{t.penalty}% penalty</div>
                                )}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Artifact */}
                <div>
                    <label className="block text-sm text-gray-400 mb-1">Artifact NFT</label>
                    <select
                        value={artifactBoost}
                        onChange={e => setArtifactBoost(parseInt(e.target.value))}
                        className="w-full bg-black/50 border border-amber-500/30 rounded-lg px-4 py-3 text-white focus:border-amber-500 focus:outline-none text-sm"
                    >
                        {ARTIFACTS.map(a => (
                            <option key={a.boost} value={a.boost}>
                                {a.boost === 0
                                    ? 'None'
                                    : `${a.name} +${a.boost}% — ${a.price} XNT (break-even: ${(a.price * 100 / a.boost)} XNT allocation)`}
                            </option>
                        ))}
                    </select>
                    {artifactBoost > 0 && (
                        <p className="text-xs text-gray-500 mt-1">
                            Ratio: 1 XNT per 1% boost · break-even at{' '}
                            <strong className="text-amber-400">{breakEvenAlloc} XNT</strong>{' '}
                            allocation in epoch. Below this: loss. Above: increasing profit.
                        </p>
                    )}
                </div>
            </div>

            {/* ── SCORE BREAKDOWN ────────────────────────────────────────── */}
            <div className="bg-black/40 rounded-lg p-4 space-y-3">
                <p className="text-xs text-gray-500 font-semibold uppercase tracking-wide">Forge Score — Step-by-Step</p>

                {/* Step visualization */}
                <div className="space-y-1 text-sm">
                    <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-gray-800 text-gray-400 text-xs flex items-center justify-center flex-shrink-0">1</span>
                        <span className="text-gray-400">XEN × CWF</span>
                        <ArrowRight className="w-3 h-3 text-gray-600 flex-shrink-0" />
                        <span className="text-white font-mono">{score.xenNorm.toFixed(2)}</span>
                        <span className="text-gray-600 text-xs">(normalized)</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-gray-800 text-gray-400 text-xs flex items-center justify-center flex-shrink-0">2</span>
                        <span className="text-gray-400">√ (square root)</span>
                        <ArrowRight className="w-3 h-3 text-gray-600 flex-shrink-0" />
                        <span className="text-white font-mono">{score.raw.toFixed(4)}</span>
                        <span className="text-gray-600 text-xs">(anti-whale compression)</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="w-5 h-5 rounded-full bg-gray-800 text-gray-400 text-xs flex items-center justify-center flex-shrink-0">3</span>
                        <span className="text-gray-400">× Tier {tier.multiplier}×</span>
                        <ArrowRight className="w-3 h-3 text-gray-600 flex-shrink-0" />
                        <span className="text-white font-mono">{score.tiered.toFixed(4)}</span>
                    </div>
                    {artifactBoost > 0 && (
                        <div className="flex items-center gap-2">
                            <span className="w-5 h-5 rounded-full bg-purple-900 text-purple-400 text-xs flex items-center justify-center flex-shrink-0">4</span>
                            <span className="text-purple-400">× Artifact +{artifactBoost}%</span>
                            <ArrowRight className="w-3 h-3 text-gray-600 flex-shrink-0" />
                            <span className="text-purple-300 font-mono">{score.boosted.toFixed(4)}</span>
                            <span className="text-purple-600 text-xs">(+{(score.boosted - score.tiered).toFixed(4)} pts)</span>
                        </div>
                    )}
                </div>

                {/* Final */}
                <div className="border-t border-gray-700 pt-3 grid grid-cols-2 gap-4">
                    <div>
                        <p className="text-xs text-gray-500">Final Forge Score</p>
                        <p className="text-2xl font-bold text-amber-400">{score.boosted.toFixed(4)}</p>
                        <p className="text-xs text-gray-600">points this epoch</p>
                    </div>
                    <div>
                        <p className="text-xs text-gray-500">Estimated Value (1 pt ≈ 1 XNT*)</p>
                        <p className="text-2xl font-bold text-green-400">${(score.boosted * xntPrice).toFixed(4)}</p>
                        <p className="text-xs text-gray-600">in {tier.days} days</p>
                    </div>
                </div>

                {tier.penalty > 0 && (
                    <p className="text-xs text-yellow-500 flex items-center gap-1 pt-1 border-t border-gray-800">
                        <AlertTriangle className="w-3 h-3" />
                        Early Exit: lose {tier.penalty}% of non-vested balance
                    </p>
                )}

                <p className="text-xs text-gray-700">
                    * Real XNT = proportional to your score vs total epoch score. This number is illustrative (score ≈ XNT if you were the only pilot).
                </p>
            </div>

            {/* ── TIER COMPARISON ────────────────────────────────────────── */}
            <div>
                <p className="text-xs text-gray-500 font-semibold uppercase tracking-wide mb-2">
                    Tier Comparison — Same Chain and NFT
                </p>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-gray-500 border-b border-gray-800 text-xs">
                                <th className="text-left pb-2">Tier</th>
                                <th className="text-right pb-2">Mult.</th>
                                <th className="text-right pb-2">Score</th>
                                <th className="text-right pb-2">vs current</th>
                                <th className="text-right pb-2">Lock</th>
                                <th className="text-right pb-2">Penalty</th>
                            </tr>
                        </thead>
                        <tbody>
                            {tierComparison.map(t => {
                                const isCurrent = t.id === selectedTierId;
                                const diff      = t.score.boosted - score.boosted;
                                const pct       = score.boosted > 0 ? ((t.score.boosted / score.boosted - 1) * 100) : 0;
                                return (
                                    <tr
                                        key={t.id}
                                        onClick={() => setSelectedTierId(t.id)}
                                        className={`border-b border-gray-800/50 cursor-pointer transition-colors ${
                                            isCurrent ? 'bg-amber-500/10' : 'hover:bg-white/5'
                                        }`}
                                    >
                                        <td className={`py-2 font-bold ${isCurrent ? t.color : 'text-gray-400'}`}>
                                            {t.name}{isCurrent && <span className="ml-1 text-xs">←</span>}
                                        </td>
                                        <td className="py-2 text-right text-gray-300">{t.multiplier}×</td>
                                        <td className={`py-2 text-right font-mono ${isCurrent ? 'text-white' : 'text-gray-400'}`}>
                                            {t.score.boosted.toFixed(2)}
                                        </td>
                                        <td className={`py-2 text-right text-xs ${diff > 0 ? 'text-green-400' : diff < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                                            {isCurrent ? '—' : `${diff > 0 ? '+' : ''}${pct.toFixed(0)}%`}
                                        </td>
                                        <td className="py-2 text-right text-gray-500 text-xs">{t.days}d</td>
                                        <td className={`py-2 text-right text-xs ${t.penalty > 0 ? 'text-red-400' : 'text-green-400'}`}>
                                            {t.penalty > 0 ? `${t.penalty}%` : 'None'}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                <p className="text-xs text-gray-700 mt-1">Click on a row to simulate the tier.</p>
            </div>

            {/* ── ARTIFACT ROI SIMULATOR ─────────────────────────────────── */}
            {artifactBoost > 0 && (
                <div className="bg-black/40 border border-purple-500/20 rounded-lg p-4 space-y-3">
                    <div className="flex items-center gap-2">
                        <Zap className="w-4 h-4 text-purple-400" />
                        <span className="text-sm font-bold text-purple-400">Simulador ROI — {artifact.name}</span>
                        <span className="ml-auto text-xs text-gray-500">{artifact.price} XNT · +{artifact.boost}% boost</span>
                    </div>

                    {/* Scenario table */}
                    <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="text-gray-500 border-b border-gray-800">
                                    <th className="text-left pb-1">Alocação no epoch</th>
                                    <th className="text-right pb-1">NFT adiciona</th>
                                    <th className="text-right pb-1">Custo NFT</th>
                                    <th className="text-right pb-1">Resultado líquido</th>
                                    <th className="text-right pb-1"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {[breakEvenAlloc * 0.5, breakEvenAlloc, breakEvenAlloc * 2, breakEvenAlloc * 5].map((alloc, i) => {
                                    const extra = alloc * (artifactBoost / 100);
                                    const net   = extra - artifactPrice;
                                    const labels = ['Pessimistic', 'Break-even', 'Moderate', 'Optimistic'];
                                    return (
                                        <tr key={i} className="border-b border-gray-800/40">
                                            <td className="py-1.5">
                                                <span className="text-gray-300">{alloc.toFixed(0)} XNT</span>
                                                <span className="ml-2 text-gray-600 text-xs">{labels[i]}</span>
                                            </td>
                                            <td className="py-1.5 text-right text-green-400">+{extra.toFixed(1)} XNT</td>
                                            <td className="py-1.5 text-right text-gray-500">−{artifactPrice} XNT</td>
                                            <td className={`py-1.5 text-right font-bold ${net > 0 ? 'text-green-400' : net === 0 ? 'text-yellow-400' : 'text-red-400'}`}>
                                                {net >= 0 ? '+' : ''}{net.toFixed(1)} XNT
                                            </td>
                                            <td className="py-1.5 text-right">
                                                {net > 0 ? <CheckCircle className="w-3 h-3 text-green-400 inline" /> : net === 0 ? '➖' : <XCircle className="w-3 h-3 text-red-400 inline" />}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    {/* Custom allocation */}
                    <div>
                        <label className="text-xs text-gray-400">My expected allocation this epoch (XNT)</label>
                        <input
                            type="number"
                            value={expectedAllocation}
                            onChange={e => setExpectedAllocation(e.target.value)}
                            placeholder={`Enter to see customized result — break-even: ${breakEvenAlloc} XNT`}
                            className="w-full mt-1 bg-black/50 border border-purple-500/30 rounded-lg px-3 py-2 text-white text-sm focus:border-purple-400 focus:outline-none"
                        />
                    </div>

                    {hasAllocInput && (
                        <div className={`flex items-start gap-3 p-3 rounded-lg border ${
                            nftNet > 0  ? 'bg-green-500/10 border-green-500/30' :
                            nftNet === 0 ? 'bg-yellow-500/10 border-yellow-500/30' :
                                          'bg-red-500/10 border-red-500/30'
                        }`}>
                            {nftNet > 0 ? <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                                        : nftNet === 0 ? <Info className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
                                        : <XCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />}
                            <div>
                                <p className={`font-bold text-sm ${nftNet > 0 ? 'text-green-400' : nftNet === 0 ? 'text-yellow-400' : 'text-red-400'}`}>
                                    {nftNet > 0 ? '✓ Profitable' : nftNet === 0 ? '➖ Break-even' : '✗ Not yet worth it'}
                                </p>
                                <p className="text-xs text-gray-400 mt-0.5">
                                    NFT costs {artifactPrice} XNT · adds +{nftExtra.toFixed(2)} XNT ·
                                    net result{' '}
                                    <span className={nftNet >= 0 ? 'text-green-400 font-bold' : 'text-red-400 font-bold'}>
                                        {nftNet >= 0 ? '+' : ''}{nftNet.toFixed(2)} XNT
                                    </span>
                                    {nftNet < 0 && (
                                        <> · missing <strong className="text-amber-400">{(breakEvenAlloc - userAlloc).toFixed(1)} XNT</strong> in allocation to break-even</>
                                    )}
                                </p>
                            </div>
                        </div>
                    )}

                    <p className="text-xs text-gray-700">
                        * Real allocation depends on your score vs all pilots in the epoch and the pool balance.
                        Track it in Mission Control before deciding.
                    </p>
                </div>
            )}

            {/* ── FORGE ADVISOR ──────────────────────────────────────────── */}
            <div>
                <div className="flex items-center gap-2 mb-3">
                    <Lightbulb className="w-4 h-4 text-amber-400" />
                    <span className="text-sm font-bold text-amber-400">Forge Advisor</span>
                    <span className="text-xs text-gray-600">— tips based on your current configuration</span>
                </div>
                <div className="space-y-2">
                    {tips.map((tip, i) => (
                        <div key={i} className={`rounded-lg border p-3 ${tipKindColor[tip.kind]}`}>
                            <div className="flex items-start gap-2">
                                <div className="flex-shrink-0 mt-0.5">{tip.icon}</div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-xs font-bold text-gray-300 mb-0.5">{tip.label}</p>
                                    <p className="text-xs text-gray-400 leading-relaxed">{tip.text}</p>
                                    {tip.action && tip.actionFn && (
                                        <button
                                            onClick={tip.actionFn}
                                            className="mt-2 text-xs text-amber-400 hover:text-amber-300 flex items-center gap-1 transition-colors"
                                        >
                                            <ArrowRight className="w-3 h-3" /> {tip.action}
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* ── MAX POTENTIAL ──────────────────────────────────────────── */}
            <div className="border border-gray-800 rounded-lg overflow-hidden">
                <button
                    onClick={() => setShowMaxPotential(v => !v)}
                    className="w-full flex items-center gap-2 p-3 bg-black/30 hover:bg-black/50 transition-colors text-left"
                >
                    <Star className="w-4 h-4 text-amber-500" />
                    <span className="text-sm font-bold text-gray-300">Maximum Potential with this Volume</span>
                    <span className="ml-auto text-xs text-gray-600">ETH + Moon Landing + Void Anomaly</span>
                    {showMaxPotential
                        ? <ChevronUp className="w-4 h-4 text-gray-500 flex-shrink-0" />
                        : <ChevronDown className="w-4 h-4 text-gray-500 flex-shrink-0" />}
                </button>
                {showMaxPotential && (
                    <div className="p-4 bg-black/20 space-y-3">
                        <p className="text-xs text-gray-500">
                            What would happen if you burned these {amount.toLocaleString()} tokens on
                            Ethereum, with Moon Landing (3×) and Void Anomaly (+50%)?
                        </p>

                        {/* Step-by-step max */}
                        <div className="space-y-1 text-xs font-mono">
                            <div className="flex gap-2"><span className="text-gray-600">XEN × CWF 1.0</span><span className="text-gray-300">= {(amount).toFixed(2)}</span></div>
                            <div className="flex gap-2"><span className="text-gray-600">√ raiz</span><span className="text-gray-300">= {Math.sqrt(amount).toFixed(4)}</span></div>
                            <div className="flex gap-2"><span className="text-gray-600">× 3.0 (Moon Landing)</span><span className="text-gray-300">= {(Math.sqrt(amount) * 3).toFixed(4)}</span></div>
                            <div className="flex gap-2"><span className="text-purple-400">× 1.50 (Void Anomaly)</span><span className="text-purple-300 font-bold">= {maxPotential.boosted.toFixed(4)} pts</span></div>
                        </div>

                        {/* Comparison */}
                        <div className="grid grid-cols-2 gap-3">
                            <div className="bg-black/40 rounded p-3">
                                <p className="text-xs text-gray-500">Score atual</p>
                                <p className="text-lg font-bold text-gray-300">{score.boosted.toFixed(2)}</p>
                            </div>
                            <div className="bg-black/40 rounded p-3">
                                <p className="text-xs text-gray-500">Maximum Possible Score</p>
                                <p className="text-lg font-bold text-amber-400">{maxPotential.boosted.toFixed(2)}</p>
                                {maxPotential.boosted > score.boosted && (
                                    <p className="text-xs text-green-400">
                                        +{((maxPotential.boosted / score.boosted - 1) * 100).toFixed(0)}% more
                                    </p>
                                )}
                            </div>
                        </div>

                        <p className="text-xs text-gray-700">
                            Cost to reach maximum: Ethereum burn (no extra chain cost) +
                            Moon Landing lock (180 days, 50% penalty if premature exit) +
                            Void Anomaly NFT (50 XNT, supply limited to 10 units).
                        </p>

                        <div className="flex gap-2">
                            <button onClick={() => { setSelectedChainKey('ethereum'); setSelectedTierId(2); setArtifactBoost(50); }}
                                className="text-xs bg-amber-500/20 border border-amber-500/40 text-amber-400 px-3 py-1.5 rounded hover:bg-amber-500/30 transition-colors">
                                Apply Maximum Configuration
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* ── POOL HEALTH ────────────────────────────────────────────── */}
            <div className="flex items-center justify-between p-3 bg-black/30 rounded-lg">
                <div className="flex items-center gap-2">
                    <DollarSign className="w-4 h-4 text-gray-400" />
                    <span className="text-sm text-gray-400">Pool Health</span>
                </div>
                <div className={`flex items-center gap-2 ${solvencyRatio >= 150 ? 'text-green-400' : solvencyRatio >= 100 ? 'text-yellow-400' : 'text-red-400'}`}>
                    {solvencyRatio >= 100 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                    <span className="text-sm font-bold">
                        {solvencyRatio >= 150 ? 'Healthy' : solvencyRatio >= 100 ? 'Stable' : 'At Risk'}
                    </span>
                    <span className="text-xs text-gray-600">({solvencyRatio.toFixed(0)}%)</span>
                </div>
            </div>

        </div>
    );
}
