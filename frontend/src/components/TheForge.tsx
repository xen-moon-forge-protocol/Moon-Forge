/**
 * Moon Forge - THE FORGE Component v9.0
 * 
 * The main burn interface where pilots enter the forge.
 * Burn XEN on EVM chains, receive XNT on X1.
 * 
 * Features:
 * - All 5 EVM chains with rollout status
 * - ChainStatus component integration
 * - Clear EVM vs X1 wallet distinction
 */

import { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { Flame, ArrowRight, AlertCircle, CheckCircle, Loader2, Lock, Unlock, Clock } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import { useReferral } from '../context/ReferralContext';
import { CHAINS, EVM_CHAINS, TIERS, TierInfo, XEN_ABI, PORTAL_ABI, formatNumber, isChainActive, getDaysUntilUnlock, isPortalDeployed, LAUNCH_DATE } from '../lib/constants';

type BurnStep = 'input' | 'approve' | 'burn' | 'success';

export default function TheForge() {
    const { evmAddress, evmChainId, evmSigner, connectEVM, x1Address, setX1Address } = useWallet();
    const { referrer } = useReferral();

    // Form State
    const [amount, setAmount] = useState('');
    const [selectedTier, setSelectedTier] = useState<TierInfo>(TIERS[0]);
    const [selectedChain, setSelectedChain] = useState<string>('optimism');
    const [targetX1, setTargetX1] = useState('');
    const [step, setStep] = useState<BurnStep>('input');

    // Balance & Allowance
    const [xenBalance, setXenBalance] = useState<bigint>(0n);
    const [allowance, setAllowance] = useState<bigint>(0n);

    // Loading states
    const [loading, setLoading] = useState(false);
    const [txHash, setTxHash] = useState('');
    const [error, setError] = useState('');

    // Get current chain config
    const currentChain = CHAINS[selectedChain];
    const chainActive = isChainActive(selectedChain as any);
    const daysUntilUnlock = getDaysUntilUnlock(selectedChain as any);

    // Load XEN balance
    useEffect(() => {
        if (!evmAddress || !evmSigner) return;

        const loadBalance = async () => {
            try {
                const xenContract = new ethers.Contract(currentChain.xenToken, XEN_ABI, evmSigner);
                const bal = await xenContract.balanceOf(evmAddress);
                const allow = await xenContract.allowance(evmAddress, currentChain.portalAddress);
                setXenBalance(bal);
                setAllowance(allow);
            } catch (err) {
                console.error('Failed to load balance:', err);
            }
        };

        loadBalance();
    }, [evmAddress, evmSigner, currentChain]);

    // Pre-fill X1 address from context
    useEffect(() => {
        if (x1Address && !targetX1) {
            setTargetX1(x1Address);
        }
    }, [x1Address, targetX1]);

    // ─────────────────────────────────────────────────────────────────────────
    //                              HANDLERS
    // ─────────────────────────────────────────────────────────────────────────

    const handleApprove = async () => {
        if (!evmSigner) return;
        setLoading(true);
        setError('');

        try {
            const xenContract = new ethers.Contract(currentChain.xenToken, XEN_ABI, evmSigner);
            const amountWei = ethers.parseEther(amount);

            const tx = await xenContract.approve(currentChain.portalAddress, amountWei);
            await tx.wait();

            setAllowance(amountWei);
            setStep('burn');
        } catch (err: any) {
            setError(err.message || 'Approval failed');
        } finally {
            setLoading(false);
        }
    };

    const handleBurn = async () => {
        if (!evmSigner) return;
        setLoading(true);
        setError('');

        try {
            const portalContract = new ethers.Contract(currentChain.portalAddress, PORTAL_ABI, evmSigner);
            const amountWei = ethers.parseEther(amount);

            // Pass referrer to contract (or zero address if none)
            const referrerAddress = referrer || ethers.ZeroAddress;
            const tx = await portalContract.enterForge(amountWei, selectedTier.id, targetX1, referrerAddress);
            const receipt = await tx.wait();

            setTxHash(receipt.hash);
            setStep('success');

            // Save X1 address to context
            setX1Address(targetX1);
        } catch (err: any) {
            setError(err.message || 'Burn failed');
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = () => {
        if (!chainActive) {
            setError(`${currentChain.name} unlocks in ${daysUntilUnlock} days`);
            return;
        }

        const amountWei = ethers.parseEther(amount || '0');

        if (allowance >= amountWei) {
            setStep('burn');
        } else {
            setStep('approve');
        }
    };

    const resetForm = () => {
        setAmount('');
        setStep('input');
        setTxHash('');
        setError('');
    };

    // ─────────────────────────────────────────────────────────────────────────
    //                              VALIDATION
    // ─────────────────────────────────────────────────────────────────────────

    const amountNum = parseFloat(amount) || 0;
    const balanceNum = parseFloat(ethers.formatEther(xenBalance));
    const isValidAmount = amountNum > 0 && amountNum <= balanceNum;
    // X1 address = Base58 Solana public key (from X1 Wallet official or Backpack — Phantom NOT compatible)
    // 32-44 chars, no 0x prefix — completely different from EVM addresses
    const isValidX1 = targetX1.length >= 32 && targetX1.length <= 44 && !targetX1.startsWith('0x');
    const canProceed = evmAddress && isValidAmount && isValidX1 && chainActive && isPortalDeployed(selectedChain);

    // Calculate estimated reward (using correct multipliers)
    const estimatedScore = Math.sqrt(amountNum) * selectedTier.multiplier;

    // ─────────────────────────────────────────────────────────────────────────
    //                              RENDER
    // ─────────────────────────────────────────────────────────────────────────

    return (
        <div className="max-w-4xl mx-auto">
            <div className="text-center mb-8">
                <h1 className="font-space text-4xl font-bold mb-2">
                    <span className="text-forge-orange">🔥</span> The Forge
                </h1>
                <p className="text-lunar-400">
                    Burn your XEN. Forge your future on X1.
                </p>
            </div>

            {/* Chain Rollout Status */}
            <ChainRolloutBanner />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Main Form */}
                <div className="lg:col-span-2 glass-card">
                    {step === 'success' ? (
                        <SuccessState txHash={txHash} chainExplorer={currentChain.explorer} onReset={resetForm} />
                    ) : (
                        <>
                            {/* Chain Selector - ALL 5 CHAINS */}
                            <div className="mb-6">
                                <label className="block text-sm text-lunar-400 mb-2">Burn From Chain</label>
                                <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                                    {EVM_CHAINS.map(chainKey => {
                                        const chain = CHAINS[chainKey];
                                        const active = isChainActive(chainKey);
                                        const deployed = isPortalDeployed(chainKey);
                                        const days = getDaysUntilUnlock(chainKey);
                                        const isSelected = selectedChain === chainKey;
                                        const canSelect = active && deployed;

                                        return (
                                            <button
                                                key={chainKey}
                                                onClick={() => setSelectedChain(chainKey)}
                                                disabled={!canSelect}
                                                title={!deployed ? 'Portal not yet deployed — community can help!' : undefined}
                                                className={`relative p-3 rounded-xl border-2 transition-all ${isSelected
                                                    ? 'border-forge-orange bg-forge-orange/10'
                                                    : canSelect
                                                        ? 'border-white/10 hover:border-white/20'
                                                        : 'border-white/5 opacity-40 cursor-not-allowed'
                                                    }`}
                                            >
                                                <div
                                                    className="w-4 h-4 rounded-full mb-1 mx-auto"
                                                    style={{ backgroundColor: chain.color }}
                                                />
                                                <div className="text-sm font-medium">{chain.shortName}</div>
                                                {!active && (
                                                    <div className="absolute -top-2 -right-2 bg-amber-500 text-black text-xs px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                                                        <Lock className="w-3 h-3" />
                                                        {days}d
                                                    </div>
                                                )}
                                                {active && !deployed && (
                                                    <div className="absolute -top-2 -right-2 bg-lunar-600 text-white text-xs px-1 py-0.5 rounded-full">
                                                        soon
                                                    </div>
                                                )}
                                                {canSelect && (
                                                    <div className="absolute -top-2 -right-2 bg-green-500 text-black text-xs px-1.5 py-0.5 rounded-full">
                                                        <Unlock className="w-3 h-3" />
                                                    </div>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Chain Lock Warning */}
                            {!chainActive && (
                                <div className="mb-6 p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-center gap-3">
                                    <Clock className="w-5 h-5 text-amber-400 flex-shrink-0" />
                                    <div>
                                        <p className="text-amber-400 font-medium">{currentChain.name} unlocks in {daysUntilUnlock} days</p>
                                        <p className="text-lunar-400 text-sm">Use Optimism for immediate burns</p>
                                    </div>
                                </div>
                            )}

                            {/* Community Deploy Notice */}
                            {chainActive && !isPortalDeployed(selectedChain) && (
                                <div className="mb-6 p-4 bg-lunar-800/60 border border-white/10 rounded-xl flex items-start gap-3">
                                    <AlertCircle className="w-5 h-5 text-lunar-300 flex-shrink-0 mt-0.5" />
                                    <div>
                                        <p className="text-white font-medium">Portal not yet deployed on {currentChain.name}</p>
                                        <p className="text-lunar-400 text-sm mt-1">
                                            This is a community-driven protocol. Anyone can deploy the portal on this chain by following the{' '}
                                            <a href="https://github.com/moon-forge-dao/protocol/blob/main/DEPLOY.md" target="_blank" rel="noopener noreferrer" className="text-forge-orange underline">
                                                DEPLOY.md guide
                                            </a>
                                            . Use Optimism to burn now.
                                        </p>
                                    </div>
                                </div>
                            )}

                            {/* Amount Input */}
                            <div className="mb-6">
                                <label className="block text-sm text-lunar-400 mb-2">XEN Amount</label>
                                <div className="relative">
                                    <input
                                        type="number"
                                        value={amount}
                                        onChange={(e) => setAmount(e.target.value)}
                                        placeholder="Enter amount to burn"
                                        className="input-forge pr-20"
                                        disabled={step !== 'input'}
                                    />
                                    <button
                                        onClick={() => setAmount(ethers.formatEther(xenBalance))}
                                        className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-1 bg-forge-orange/20 text-forge-orange text-sm rounded-lg hover:bg-forge-orange/30"
                                    >
                                        MAX
                                    </button>
                                </div>
                                <div className="flex justify-between mt-1 text-xs text-lunar-400">
                                    <span>Balance: {evmAddress ? formatNumber(balanceNum) : '--'} XEN</span>
                                    {!isValidAmount && amount && <span className="text-red-400">Insufficient balance</span>}
                                </div>
                            </div>

                            {/* Tier Selection */}
                            <div className="mb-6">
                                <label className="block text-sm text-lunar-400 mb-2">Mission Tier</label>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                    {TIERS.map(tier => (
                                        <TierCard
                                            key={tier.id}
                                            tier={tier}
                                            selected={selectedTier.id === tier.id}
                                            onClick={() => setSelectedTier(tier)}
                                            disabled={step !== 'input'}
                                        />
                                    ))}
                                </div>
                            </div>

                            {/* X1 Target Address */}
                            <div className="mb-6">
                                <label className="block text-sm text-lunar-400 mb-2">
                                    X1 Wallet Address <span className="text-amber-400">(Destination for XNT)</span>
                                </label>
                                <input
                                    type="text"
                                    value={targetX1}
                                    onChange={(e) => setTargetX1(e.target.value)}
                                    placeholder="Your X1 address (Base58, from X1 Wallet / Backpack)"
                                    className="input-forge font-mono text-sm"
                                    disabled={step !== 'input'}
                                />
                                {!isValidX1 && targetX1 && (
                                    <p className="mt-1 text-xs text-red-400">Invalid X1 address — must be Base58 format (32–44 chars, from X1 Wallet or Backpack, not 0x...)</p>
                                )}
                            </div>

                            {/* Error Display */}
                            {error && (
                                <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-xl flex items-center gap-2 text-red-400">
                                    <AlertCircle className="w-5 h-5 flex-shrink-0" />
                                    <span className="text-sm">{error}</span>
                                </div>
                            )}

                            {/* Action Buttons */}
                            <div className="space-y-3">
                                {!evmAddress ? (
                                    <button onClick={connectEVM} className="w-full btn-forge">
                                        Connect EVM Wallet (for XEN)
                                    </button>
                                ) : step === 'input' ? (
                                    <button
                                        onClick={handleSubmit}
                                        disabled={!canProceed}
                                        className="w-full btn-forge flex items-center justify-center gap-2"
                                    >
                                        Continue <ArrowRight className="w-5 h-5" />
                                    </button>
                                ) : step === 'approve' ? (
                                    <button
                                        onClick={handleApprove}
                                        disabled={loading}
                                        className="w-full btn-forge flex items-center justify-center gap-2"
                                    >
                                        {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
                                        {loading ? 'Approving...' : 'Approve XEN'}
                                    </button>
                                ) : step === 'burn' ? (
                                    <button
                                        onClick={handleBurn}
                                        disabled={loading}
                                        className="w-full btn-forge flex items-center justify-center gap-2"
                                    >
                                        {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Flame className="w-5 h-5" />}
                                        {loading ? 'Burning...' : 'BURN XEN 🔥'}
                                    </button>
                                ) : null}

                                {step !== 'input' && !loading && (
                                    <button onClick={resetForm} className="w-full btn-outline">
                                        ← Go Back
                                    </button>
                                )}
                            </div>
                        </>
                    )}
                </div>

                {/* Estimation Panel */}
                <div className="glass-card h-fit">
                    <h3 className="font-space text-lg text-forge-gold mb-4">Burn Estimate</h3>

                    <div className="space-y-4">
                        <div className="flex justify-between text-sm">
                            <span className="text-lunar-400">XEN Amount</span>
                            <span className="text-white">{formatNumber(amountNum)}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                            <span className="text-lunar-400">Tier</span>
                            <span style={{ color: selectedTier.color }}>{selectedTier.icon} {selectedTier.name}</span>
                        </div>
                        <div className="flex justify-between text-sm">
                            <span className="text-lunar-400">Multiplier</span>
                            <span className="text-forge-gold">{selectedTier.multiplier}x</span>
                        </div>
                        <div className="flex justify-between text-sm">
                            <span className="text-lunar-400">Vesting Period</span>
                            <span className="text-white">{selectedTier.duration} days</span>
                        </div>

                        <hr className="border-white/10" />

                        <div className="flex justify-between text-sm">
                            <span className="text-lunar-400">Base Score (√amount)</span>
                            <span className="text-white">{formatNumber(Math.sqrt(amountNum))}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-lunar-400">Final Score</span>
                            <span className="text-forge-gold font-bold text-xl">{formatNumber(estimatedScore)}</span>
                        </div>

                        <p className="text-xs text-lunar-400 mt-4">
                            Your XNT rewards depend on your share of the total score pool for this epoch.
                            Higher tier = longer lock = bigger multiplier.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
//                              SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════

function ChainRolloutBanner() {
    return (
        <div className="glass-card bg-gradient-to-r from-space-700/50 to-forge-orange/10 border-forge-orange/30 mb-6">
            <div className="flex items-center justify-between flex-wrap gap-4">
                <div>
                    <h3 className="font-space text-white mb-1">Multi-Chain Rollout</h3>
                    <p className="text-lunar-400 text-sm">Chains unlock progressively for fair distribution</p>
                </div>
                <div className="flex items-center gap-4 text-sm">
                    <div className="flex items-center gap-1 text-green-400">
                        <Unlock className="w-4 h-4" />
                        <span>ETH, OP</span>
                    </div>
                    <div className="flex items-center gap-1 text-amber-400">
                        <Clock className="w-4 h-4" />
                        <span>BSC: Day 14</span>
                    </div>
                    <div className="flex items-center gap-1 text-amber-400">
                        <Clock className="w-4 h-4" />
                        <span>MATIC, AVAX: Day 27</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

function TierCard({ tier, selected, onClick, disabled }: { tier: TierInfo; selected: boolean; onClick: () => void; disabled: boolean }) {
    const borderClass = tier.id === 0 ? 'tier-launchpad' : tier.id === 1 ? 'tier-orbit' : 'tier-moon';

    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={`tier-card text-left ${borderClass} ${selected ? 'selected' : ''}`}
        >
            <div className="flex items-center gap-2 mb-2">
                <span className="text-2xl">{tier.icon}</span>
                <span className="font-space" style={{ color: tier.color }}>{tier.name}</span>
            </div>
            <div className="text-xs text-lunar-400 space-y-1">
                <div>{tier.duration} days vesting</div>
                <div className="text-forge-gold font-bold">{tier.multiplier}x bonus</div>
                <div className={tier.penalty === 0 ? 'text-green-400' : 'text-red-400'}>
                    {tier.penalty}% exit penalty
                </div>
            </div>
        </button>
    );
}

function SuccessState({ txHash, chainExplorer, onReset }: { txHash: string; chainExplorer: string; onReset: () => void }) {
    return (
        <div className="text-center py-8">
            <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-green-500/20 flex items-center justify-center">
                <CheckCircle className="w-10 h-10 text-green-400" />
            </div>
            <h2 className="font-space text-2xl text-forge-gold mb-2">Mission Initiated! 🚀</h2>
            <p className="text-lunar-400 mb-6">
                Your XEN has been burned. Your mission is now active.
            </p>

            <a
                href={`${chainExplorer}/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block mb-6 text-forge-orange hover:underline"
            >
                View Transaction →
            </a>

            <div className="space-y-3">
                <a href="/Moon-Forge/missions" className="block w-full btn-forge">
                    View My Missions
                </a>
                <button onClick={onReset} className="w-full btn-outline">
                    Burn More XEN
                </button>
            </div>
        </div>
    );
}
