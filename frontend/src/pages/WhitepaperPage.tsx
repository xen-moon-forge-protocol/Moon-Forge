import React, { useState } from 'react';
import {
    Book, ChevronDown, ChevronRight, Flame, Clock, Star,
    AlertTriangle, Calculator, HelpCircle, ExternalLink, Coins, Target,
    Zap, Award, TrendingUp, Lock, Unlock, RefreshCw, Gamepad2, BarChart2, Globe, Heart, CheckCircle,
    Lightbulb, ShieldCheck, ArrowRight
} from 'lucide-react';
import { TIERS, FEE_STRUCTURE, ARTIFACT_TIERS, EVM_CHAINS, CHAINS, ROLLOUT_SCHEDULE, CWF_DEFAULTS, STREAK_CONFIG, PRICE_FACTOR_CONFIG, getStreakMultiplier, getStreakMinXenForChain } from '../lib/constants';

/**
 * WHITEPAPER PAGE v12.0 - COMPLETE DOCUMENTATION
 *
 * Everything you need to understand Moon Forge:
 * - Protocol mechanics
 * - Tier system with exact numbers (1.0x / 2.0x / 3.0x)
 * - CWF (Chain Weight Factor) — cross-chain fairness
 * - NFT rules (pricing, usage, 7-day decay)
 * - Epoch system
 * - Claiming process
 * - Fee distribution (v8.0: 93.5% pool / 1% oracle / 2% referrer / 3.5% dev)
 * - Risks
 */
export default function WhitepaperPage() {
    const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['intro']));

    const toggleSection = (id: string) => {
        const newSet = new Set(expandedSections);
        if (newSet.has(id)) {
            newSet.delete(id);
        } else {
            newSet.add(id);
        }
        setExpandedSections(newSet);
    };

    const expandAll = () => {
        setExpandedSections(new Set([
            'intro', 'how-it-works', 'tiers', 'nfts', 'epochs', 'claiming',
            'fees', 'donations', 'chains', 'cwf', 'streak', 'solvency', 'moonparty', 'risks', 'faq', 'glossary', 'gaming',
            'strategy'
        ]));
    };

    const Section = ({ id, title, icon: Icon, children }: {
        id: string;
        title: string;
        icon: React.ElementType;
        children: React.ReactNode;
    }) => {
        const isExpanded = expandedSections.has(id);
        return (
            <div className="border border-gray-800 rounded-lg overflow-hidden mb-4">
                <button
                    onClick={() => toggleSection(id)}
                    className="w-full flex items-center gap-3 p-4 bg-black/50 hover:bg-black/70 transition-colors text-left"
                >
                    <Icon className="w-5 h-5 text-amber-400 flex-shrink-0" />
                    <span className="flex-1 font-bold text-white">{title}</span>
                    {isExpanded ? (
                        <ChevronDown className="w-5 h-5 text-gray-500" />
                    ) : (
                        <ChevronRight className="w-5 h-5 text-gray-500" />
                    )}
                </button>
                {isExpanded && (
                    <div className="p-6 bg-black/30 border-t border-gray-800">
                        {children}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="min-h-screen bg-gradient-to-b from-gray-900 to-black py-12 px-4">
            <div className="max-w-4xl mx-auto">
                {/* Header */}
                <div className="text-center mb-8">
                    <div className="flex items-center justify-center gap-3 mb-4">
                        <Book className="w-10 h-10 text-amber-400" />
                        <h1 className="text-4xl font-bold text-white">Whitepaper</h1>
                    </div>
                    <p className="text-gray-400 text-lg">
                        Complete protocol documentation. Read before burning.
                    </p>
                    <p className="text-amber-500 text-sm mt-2">Full Documentation</p>
                    <button
                        onClick={expandAll}
                        className="mt-4 text-sm text-amber-400 hover:text-amber-300"
                    >
                        Expand All Sections
                    </button>
                </div>

                {/* Critical Warning */}
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-8">
                    <div className="flex items-start gap-3">
                        <AlertTriangle className="w-6 h-6 text-red-400 flex-shrink-0" />
                        <div>
                            <h3 className="font-bold text-red-400 mb-1">⚠️ Critical Disclaimer</h3>
                            <ul className="text-sm text-gray-300 space-y-1">
                                <li>• Moon Forge is a <strong>community-built protocol</strong>. NOT affiliated with official X1 team.</li>
                                <li>• Burning XEN is <strong>permanent and irreversible</strong>.</li>
                                <li>• XNT rewards are <strong>NOT guaranteed</strong> - depends on pool and participation.</li>
                                <li>• This is <strong>experimental software</strong>. Use at your own risk.</li>
                            </ul>
                        </div>
                    </div>
                </div>

                {/* ═══════════════════════════════════════════════════════════════ */}
                {/*                        SECTION 1: INTRO                         */}
                {/* ═══════════════════════════════════════════════════════════════ */}
                <Section id="intro" title="1. What is Moon Forge?" icon={Flame}>
                    <div className="space-y-4 text-gray-300">
                        <p>
                            Moon Forge is a <strong className="text-amber-400">Proof-of-Burn</strong> protocol that allows you to
                            convert XEN tokens from multiple EVM chains into XNT rewards on X1 blockchain.
                        </p>

                        <div className="bg-black/50 rounded-lg p-4 border border-gray-700">
                            <p className="text-center font-mono text-lg">
                                XEN on EVM → <span className="text-red-400">🔥 BURN</span> → Score → <span className="text-amber-400">XNT on X1</span>
                            </p>
                        </div>

                        <h4 className="font-bold text-white mt-6">The Problem</h4>
                        <p>
                            The XEN community has been waiting for the X1 "Moon Party" since 2022.
                            Years passed without a clear path. Moon Forge is the community's answer.
                        </p>

                        <h4 className="font-bold text-white mt-6">How It Solves It</h4>
                        <ul className="list-disc list-inside space-y-1">
                            <li>Creates a trustless bridge from XEN (EVM) to XNT (X1)</li>
                            <li>Burns XEN permanently - deflationary pressure</li>
                            <li>Rewards long-term commitment with multipliers</li>
                            <li>100% transparent - all code is open source</li>
                        </ul>
                    </div>
                </Section>

                {/* ═══════════════════════════════════════════════════════════════ */}
                {/*                    SECTION 2: HOW IT WORKS                      */}
                {/* ═══════════════════════════════════════════════════════════════ */}
                <Section id="how-it-works" title="2. Step-by-Step Guide" icon={Calculator}>
                    <div className="space-y-6 text-gray-300">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <StepCard
                                step={1}
                                title="Connect Your Wallets"
                                items={[
                                    "EVM Wallet (MetaMask) - for XEN on Ethereum, Optimism, BSC, Polygon, Avalanche",
                                    "X1 Wallet - where you'll receive XNT rewards",
                                    "Both wallets needed for full functionality"
                                ]}
                            />
                            <StepCard
                                step={2}
                                title="Choose a Mission Tier"
                                items={[
                                    "Launchpad (5 days): 1.0x multiplier, 0% penalty",
                                    "Orbit (45 days): 2.0x multiplier, 20% penalty if early exit",
                                    "Moon Landing (180 days): 3.0x multiplier, 50% penalty if early exit"
                                ]}
                            />
                            <StepCard
                                step={3}
                                title="Burn XEN"
                                items={[
                                    "Enter amount of XEN to burn",
                                    "Approve the contract to spend your XEN",
                                    "Confirm the burn transaction",
                                    "XEN is sent to 0xdead (permanently destroyed)"
                                ]}
                            />
                            <StepCard
                                step={4}
                                title="Wait for Vesting"
                                items={[
                                    "Your rewards vest linearly over the tier duration",
                                    "Day 1: 0% available, Day 45: 100% available (for Orbit)",
                                    "Can claim any available amount at any time",
                                    "Patience = no penalty"
                                ]}
                            />
                            <StepCard
                                step={5}
                                title="Claim XNT"
                                items={[
                                    "XNT does NOT auto-transfer to your wallet",
                                    "You must manually click 'Claim' on Mission Control",
                                    "Partial claims are allowed",
                                    "Bulk claims save gas fees"
                                ]}
                            />
                            <StepCard
                                step={6}
                                title="Optional: Use NFT Boost"
                                items={[
                                    "Buy an Artifact NFT BEFORE burning",
                                    "Equip the NFT to your mission",
                                    "Get +5% to +50% reward boost",
                                    "NFT is locked until mission completes"
                                ]}
                            />
                        </div>
                    </div>
                </Section>

                {/* ═══════════════════════════════════════════════════════════════ */}
                {/*                     SECTION 3: TIER SYSTEM                      */}
                {/* ═══════════════════════════════════════════════════════════════ */}
                <Section id="tiers" title="3. Mission Tiers (Detailed)" icon={Star}>
                    <div className="space-y-6 text-gray-300">
                        <p>Choose your commitment level. Higher tier = bigger multiplier = more XNT.</p>

                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left border-b border-gray-700">
                                        <th className="pb-3 pr-4">Tier</th>
                                        <th className="pb-3 pr-4">Duration</th>
                                        <th className="pb-3 pr-4">Multiplier</th>
                                        <th className="pb-3 pr-4">Early Exit Penalty</th>
                                        <th className="pb-3">Best For</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {TIERS.map(tier => (
                                        <tr key={tier.id} className="border-b border-gray-800">
                                            <td className="py-3 pr-4">
                                                <span style={{ color: tier.color }}>{tier.icon} {tier.name}</span>
                                            </td>
                                            <td className="py-3 pr-4">{tier.duration} days</td>
                                            <td className="py-3 pr-4 text-amber-400 font-bold">{tier.multiplier}x</td>
                                            <td className={`py-3 pr-4 ${tier.penalty === 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                {tier.penalty}%
                                            </td>
                                            <td className="py-3 text-gray-400">
                                                {tier.id === 0 && "Testing, low risk"}
                                                {tier.id === 1 && "Balanced risk/reward"}
                                                {tier.id === 2 && "Maximum believers"}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 mt-4">
                            <h4 className="font-bold text-amber-400 mb-2">🧮 Full Scoring Formula (v12.0 — CWF v2)</h4>
                            <p className="font-mono bg-black/50 rounded p-2 text-center text-sm">
                                Score = √(XEN × CWF) × Tier × NFT_Bonus × Streak_Mult
                            </p>
                            <div className="font-mono text-xs bg-black/30 rounded p-2 mt-2 space-y-0.5 text-gray-400">
                                <p>CWF = normalize( ISF × GCF × PF )  <span className="text-gray-600">← ETH always = 1.0</span></p>
                                <p>ISF = AMP_max / AMP_current         <span className="text-gray-600">← inflation scarcity (primary)</span></p>
                                <p>GCF = gas_ETH / gas_chain           <span className="text-gray-600">← economic effort (primary)</span></p>
                                <p>PF  = (price_chain_EMA / price_ETH_EMA)^0.33 <span className="text-gray-600">← supply scarcity (secondary)</span></p>
                            </div>
                            <p className="text-sm mt-2 text-gray-400">
                                <strong className="text-amber-400">√ key insight:</strong> Burns 4× more XEN → only 2× more points (whale compression).
                                <strong className="text-amber-400"> PF key insight:</strong> As burns reduce supply, XEN price rises → PF rises → future burns earn more.
                            </p>
                            <p className="text-xs mt-2 text-gray-500">
                                Example: 1,000,000 ETH-XEN (CWF=1.0) on Orbit (2.0×) + Cosmic Shard (+10%) + 3-epoch streak (+10%) =
                                √(1M) × 2.0 × 1.10 × 1.10 = <strong className="text-amber-400">2,420 pts</strong>
                            </p>
                        </div>

                        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
                            <h4 className="font-bold text-red-400 mb-2">⚠️ Early Exit (Eject)</h4>
                            <p className="text-gray-300 text-sm">
                                If you "eject" before your vesting completes, you lose the percentage shown above from your <strong>remaining</strong> balance.
                                The penalty goes to the reward pool for other participants.
                            </p>
                        </div>
                    </div>
                </Section>

                {/* ═══════════════════════════════════════════════════════════════ */}
                {/*                      SECTION 4: NFT SYSTEM                      */}
                {/* ═══════════════════════════════════════════════════════════════ */}
                <Section id="nfts" title="4. Artifact NFTs (Complete Rules)" icon={Target}>
                    <div className="space-y-6 text-gray-300">
                        <p>
                            Artifacts are <strong className="text-amber-400">boost NFTs</strong> that increase your rewards.
                            They are optional but strategic.
                        </p>

                        {/* NFT Tiers Table */}
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left border-b border-gray-700">
                                        <th className="pb-3 pr-4">Artifact</th>
                                        <th className="pb-3 pr-4">Max Supply</th>
                                        <th className="pb-3 pr-4">Base Price</th>
                                        <th className="pb-3 pr-4">Boost</th>
                                        <th className="pb-3">Pricing Type</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {ARTIFACT_TIERS.map(tier => (
                                        <tr key={tier.tier} className="border-b border-gray-800">
                                            <td className="py-3 pr-4 font-medium">
                                                {tier.name}
                                                {tier.exclusiveToMissionTier === 2 && (
                                                    <span className="ml-2 text-xs bg-amber-500/20 text-amber-400 border border-amber-500/40 rounded px-1.5 py-0.5">
                                                        Moon Landing+ Exclusive
                                                    </span>
                                                )}
                                            </td>
                                            <td className="py-3 pr-4">{tier.maxSupply}</td>
                                            <td className="py-3 pr-4">{tier.basePrice} XNT</td>
                                            <td className="py-3 pr-4 text-green-400 font-bold">+{tier.boost}%</td>
                                            <td className={`py-3 ${tier.isDynamic ? 'text-amber-400' : 'text-green-400'}`}>
                                                {tier.isDynamic ? 'Dynamic' : 'Fixed'}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <p className="text-xs text-gray-500">
                            * Void Anomaly is recommended for Moon Landing (Tier 2) pilots — its +50% boost is most impactful on longer locks.
                            This is a UI guideline only; the contract does not enforce tier restrictions on NFT purchases.
                        </p>

                        {/* Dynamic Pricing Rules */}
                        <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-4">
                            <h4 className="font-bold text-purple-400 mb-3 flex items-center gap-2">
                                <TrendingUp className="w-5 h-5" /> Dynamic Pricing Rules
                            </h4>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                                <div>
                                    <p className="text-green-400 font-medium">📈 Price Increases:</p>
                                    <ul className="text-gray-300 mt-1 space-y-1">
                                        <li>• Each purchase = <strong>+5%</strong> to next buyer's price</li>
                                        <li>• Creates "sniper" game - early buyers win</li>
                                    </ul>
                                </div>
                                <div>
                                    <p className="text-cyan-400 font-medium">📉 Price Decay (7-Day Rule):</p>
                                    <ul className="text-gray-300 mt-1 space-y-1">
                                        <li>• If no sale for 7 days = <strong>-5%</strong> price drop</li>
                                        <li>• Price <strong>can never fall below the original base price</strong> set at deployment</li>
                                        <li>• E.g. Cosmic Shard floor = 5 XNT, always. Void Anomaly floor = 50 XNT, always.</li>
                                        <li>• Floor is enforced by the contract, not policy</li>
                                    </ul>
                                </div>
                            </div>
                        </div>

                        {/* Usage Rules */}
                        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
                            <h4 className="font-bold text-blue-400 mb-3 flex items-center gap-2">
                                <Lock className="w-5 h-5" /> NFT Usage Mechanics
                            </h4>
                            <ul className="space-y-2 text-sm">
                                <li className="flex items-start gap-2">
                                    <span className="text-amber-400">1.</span>
                                    <span><strong>BEFORE burning:</strong> Equip your NFT to apply the boost</span>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-amber-400">2.</span>
                                    <span><strong>During mission:</strong> NFT is LOCKED (cannot sell or transfer)</span>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-amber-400">3.</span>
                                    <span><strong>Mission complete OR eject:</strong> NFT returns to your wallet</span>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-amber-400">4.</span>
                                    <span><strong>Reuse:</strong> You can use the same NFT for multiple missions (sequentially)</span>
                                </li>
                            </ul>
                        </div>

                        {/* NFT-specific fee split */}
                        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                            <h4 className="font-bold text-amber-400 mb-2">💰 NFT Sale Fee Split (MoonArtifacts.sol)</h4>
                            <p className="text-sm text-gray-300 mb-3">
                                NFT sales use a <strong className="text-white">different split</strong> than early-exit penalties.
                                The architect share here is 1.5% (vs 3.5% dev on penalties). Both are intentional and governed by separate contracts.
                            </p>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm text-center">
                                <div className="bg-black/50 rounded p-2">
                                    <div className="font-bold text-green-400">95.5%</div>
                                    <div className="text-gray-400">Reward Pool</div>
                                </div>
                                <div className="bg-black/50 rounded p-2">
                                    <div className="font-bold text-cyan-400">1.0%</div>
                                    <div className="text-gray-400">Oracle Gas</div>
                                </div>
                                <div className="bg-black/50 rounded p-2">
                                    <div className="font-bold text-purple-400">2.0%</div>
                                    <div className="text-gray-400">Referrer</div>
                                </div>
                                <div className="bg-black/50 rounded p-2">
                                    <div className="font-bold text-amber-400">1.5%</div>
                                    <div className="text-gray-400">Architect</div>
                                </div>
                            </div>
                        </div>

                        {/* Recycling */}
                        <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
                            <h4 className="font-bold text-green-400 mb-2 flex items-center gap-2">
                                <RefreshCw className="w-5 h-5" /> Recycling (Sniper Opportunity)
                            </h4>
                            <p className="text-sm text-gray-300">
                                When someone ejects early, their equipped NFT returns to the pool at the current dynamic price
                                (not base price — which can be higher if the NFT was previously sold multiple times).
                                This creates "snipe windows" for alert buyers.
                            </p>
                        </div>
                    </div>
                </Section>

                {/* ═══════════════════════════════════════════════════════════════ */}
                {/*                     SECTION 5: EPOCHS                           */}
                {/* ═══════════════════════════════════════════════════════════════ */}
                <Section id="epochs" title="5. Epochs & Reward Distribution" icon={Clock}>
                    <div className="space-y-6 text-gray-300">
                        <h4 className="font-bold text-white">What is an Epoch?</h4>
                        <p>
                            An epoch is a <strong className="text-amber-400">7-day period</strong> during which all burns are collected
                            and scored. At the end of each epoch, the Oracle calculates everyone's share.
                        </p>

                        <div className="bg-black/50 rounded-lg p-4 border border-gray-700">
                            <h5 className="font-bold text-amber-400 mb-2">Epoch Timeline:</h5>
                            <div className="grid grid-cols-4 gap-2 text-center text-sm">
                                <div className="bg-blue-500/20 rounded p-2">
                                    <div className="text-blue-400 font-bold">Day 1-7</div>
                                    <div className="text-gray-400">Burns collected</div>
                                </div>
                                <div className="bg-purple-500/20 rounded p-2">
                                    <div className="text-purple-400 font-bold">Day 7</div>
                                    <div className="text-gray-400">Epoch closes</div>
                                </div>
                                <div className="bg-amber-500/20 rounded p-2">
                                    <div className="text-amber-400 font-bold">Day 7-8</div>
                                    <div className="text-gray-400">Oracle calculates</div>
                                </div>
                                <div className="bg-green-500/20 rounded p-2">
                                    <div className="text-green-400 font-bold">Day 8+</div>
                                    <div className="text-gray-400">Vesting begins</div>
                                </div>
                            </div>
                        </div>

                        <h4 className="font-bold text-white mt-6">How Rewards Are Calculated</h4>
                        <div className="bg-black/50 rounded-lg p-4 border border-gray-700 font-mono text-sm">
                            <p>Your_XNT = (Your_Score / Total_Epoch_Score) × Epoch_Reward_Pool</p>
                        </div>
                        <p className="text-sm text-gray-400">
                            Your share depends on how much everyone else burned in the same epoch.
                            More total burns = smaller individual share (but more total value).
                        </p>

                        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                            <h5 className="font-bold text-amber-400 mb-2">📊 Oracle Role</h5>
                            <p className="text-sm">
                                The Oracle is a server that reads burn events from all chains, calculates scores,
                                generates Merkle proofs, and publishes them. All proofs are verifiable on-chain.
                            </p>
                        </div>

                        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
                            <h5 className="font-bold text-blue-400 mb-2">🔒 Epoch Isolation — No Mixing Between Epochs</h5>
                            <p className="text-sm text-gray-300 mb-2">
                                Each epoch is a <strong className="text-white">completely isolated distribution cycle</strong>.
                                Burns from Epoch N <em>never</em> compete with burns from Epoch M:
                            </p>
                            <ul className="text-sm space-y-1 text-gray-300">
                                <li>• The Oracle sets a separate <code className="text-blue-300">epochBudget</code> for each epoch</li>
                                <li>• Your share = <code className="text-blue-300">(your_score_in_epoch_N / total_score_in_epoch_N) × budget_N</code></li>
                                <li>• Late burners (Epoch N+1) get their own budget, isolated from Epoch N</li>
                                <li>• This prevents dilution across time — you only compete with pilots from your same burn window</li>
                            </ul>
                        </div>
                    </div>
                </Section>

                {/* ═══════════════════════════════════════════════════════════════ */}
                {/*                    SECTION 6: CLAIMING                          */}
                {/* ═══════════════════════════════════════════════════════════════ */}
                <Section id="claiming" title="6. How to Claim XNT" icon={Award}>
                    <div className="space-y-6 text-gray-300">
                        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
                            <h4 className="font-bold text-blue-400 mb-2">🔑 Key Point</h4>
                            <p className="text-lg">
                                XNT does <strong className="text-red-400">NOT</strong> automatically transfer to your wallet.
                                <br />
                                You must <strong className="text-green-400">manually claim</strong> on the Mission Control page.
                            </p>
                        </div>

                        <h4 className="font-bold text-white">Claiming Process</h4>
                        <ol className="list-decimal list-inside space-y-2">
                            <li>Go to Mission Control page</li>
                            <li>Connect your X1 wallet</li>
                            <li>See your available (vested) XNT</li>
                            <li>Click "Claim" button</li>
                            <li>Confirm transaction on X1</li>
                            <li>XNT transfers to your wallet</li>
                        </ol>

                        <h4 className="font-bold text-white mt-6">Vesting Schedule</h4>
                        <p>
                            Rewards vest <strong className="text-amber-400">linearly</strong> over your tier's duration:
                        </p>
                        <ul className="list-disc list-inside space-y-1 text-sm">
                            <li>Launchpad (5 days): 20% vests per day</li>
                            <li>Orbit (45 days): ~2.2% vests per day</li>
                            <li>Moon Landing (180 days): ~0.55% vests per day</li>
                        </ul>

                        <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
                            <h5 className="font-bold text-green-400 mb-2">💡 Gas Saving Tip</h5>
                            <p className="text-sm">
                                Each claim costs gas on X1. If you have multiple missions, consider waiting
                                for larger amounts to accumulate before claiming. Bulk claims save fees!
                            </p>
                        </div>
                    </div>
                </Section>

                {/* ═══════════════════════════════════════════════════════════════ */}
                {/*                    SECTION 7: FEES                              */}
                {/* ═══════════════════════════════════════════════════════════════ */}
                <Section id="fees" title="7. Fee Distribution (v8.0)" icon={Coins}>
                    <div className="space-y-6 text-gray-300">
                        <p>
                            <strong className="text-amber-400">Normal burns have zero fees.</strong> The split below applies only to
                            early-exit penalties (<em>ejectPilot</em>). Your XEN burn score is always credited 100% to you.
                        </p>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <FeeBox label="Reward Pool" value={`${FEE_STRUCTURE.rewardPool}%`} color="text-green-400" />
                            <FeeBox label="Oracle Gas" value={`${FEE_STRUCTURE.oracle}%`} color="text-cyan-400" />
                            <FeeBox label="Referrer" value={`${FEE_STRUCTURE.referrer}%`} color="text-purple-400" />
                            <FeeBox label="Dev Wallet" value={`${FEE_STRUCTURE.dev}%`} color="text-amber-400" />
                        </div>

                        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                            <h5 className="font-bold text-amber-400 mb-2">Early-Exit Penalty Split</h5>
                            <ul className="text-sm space-y-1">
                                <li>• <strong className="text-green-400">{FEE_STRUCTURE.rewardPool}%</strong> stays in the vault — rewards patient pilots</li>
                                <li>• <strong className="text-cyan-400">{FEE_STRUCTURE.oracle}%</strong> auto-refuels the Oracle's gas wallet</li>
                                <li>• <strong className="text-purple-400">{FEE_STRUCTURE.referrer}%</strong> goes to your referrer (if you used one)</li>
                                <li>• <strong className="text-amber-400">{FEE_STRUCTURE.dev}%</strong> goes to the dev wallet (transparent, public address)</li>
                                <li>• If <em>no referrer</em>: reward pool receives {FEE_STRUCTURE.referrer}% extra (unused referrer share stays in vault)</li>
                            </ul>
                        </div>

                        <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
                            <h5 className="font-bold text-green-400 mb-2">Burning XEN has NO fees</h5>
                            <p className="text-sm">
                                When you burn XEN, 100% of your score goes to you. The split above only activates
                                on early ejection penalties. Patient pilots pay nothing to the protocol.
                            </p>
                        </div>

                        <div className="bg-green-900/20 border border-green-500/40 rounded-lg p-4">
                            <h5 className="font-bold text-green-400 mb-2">💚 Donations — 100% Pool, Zero Split</h5>
                            <p className="text-sm text-gray-300">
                                Donations via the <code className="text-green-300">donate()</code> function are the only funding stream
                                with <strong className="text-white">absolutely no fee deduction</strong>. The full donated amount goes
                                to the reward pool, enforced in code — not by policy. See Section 15 for full details.
                            </p>
                        </div>
                    </div>
                </Section>

                {/* ═══════════════════════════════════════════════════════════════ */}
                {/*                    SECTION 8: CHAINS                            */}
                {/* ═══════════════════════════════════════════════════════════════ */}
                <Section id="chains" title="8. Supported Chains & Rollout" icon={Zap}>
                    <div className="space-y-6 text-gray-300">
                        <p>XEN can be burned from 5 EVM chains. Rollout is progressive. Each chain has its own <strong className="text-amber-400">CWF</strong> (Chain Weight Factor) that normalises its burns vs Ethereum.</p>

                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left border-b border-gray-700">
                                        <th className="pb-3 pr-4">Chain</th>
                                        <th className="pb-3 pr-4">Unlock</th>
                                        <th className="pb-3 pr-4 text-amber-400">CWF (seed)</th>
                                        <th className="pb-3">XEN Needed vs ETH</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {EVM_CHAINS.map(chainKey => {
                                        const rolloutDay = ROLLOUT_SCHEDULE[chainKey as keyof typeof ROLLOUT_SCHEDULE];
                                        const cwf = CWF_DEFAULTS[chainKey] ?? 1.0;
                                        const ratio = cwf > 0 ? Math.round(1 / cwf) : '∞';
                                        return (
                                            <tr key={chainKey} className="border-b border-gray-800">
                                                <td className="py-3 pr-4 font-bold text-white">{chainKey.charAt(0).toUpperCase() + chainKey.slice(1)}</td>
                                                <td className={`py-3 pr-4 ${rolloutDay === 0 ? 'text-green-400' : 'text-amber-400'}`}>
                                                    {rolloutDay === 0 ? 'Day 0 (Launch)' : `Day ${rolloutDay}`}
                                                </td>
                                                <td className="py-3 pr-4 font-mono text-amber-400">{cwf.toFixed(3)}×</td>
                                                <td className="py-3 text-gray-400">~{ratio}× more tokens</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
                            <h5 className="font-bold text-blue-400 mb-2">Why Progressive Rollout?</h5>
                            <p className="text-sm">
                                Starting with ETH/OP allows testing the protocol at scale before opening cheaper chains.
                                BSC unlocks on Day 13, Polygon and Avalanche on Day 26.
                            </p>
                        </div>

                        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                            <h5 className="font-bold text-amber-400 mb-2">CWF is Dynamic</h5>
                            <p className="text-sm">
                                The values above are epoch-0 seed values. Each epoch the Oracle recalculates CWF
                                on-chain using AMP (XEN inflation rate) and gas prices. The result is capped at ±20%
                                change per epoch to prevent manipulation.
                            </p>
                        </div>
                    </div>
                </Section>

                {/* ═══════════════════════════════════════════════════════════════ */}
                {/*                    SECTION 9: CWF EXPLAINED                     */}
                {/* ═══════════════════════════════════════════════════════════════ */}
                <Section id="cwf" title="9. Chain Weight Factor (CWF v2) — Why It Exists" icon={BarChart2}>
                    <div className="space-y-6 text-gray-300">
                        <p>
                            Not all XEN burns are equal. 1 ETH-XEN is economically very different from 1 Polygon-mXEN.
                            CWF v2 captures three independent economic signals to score your burn fairly across any chain.
                        </p>

                        <div className="bg-black/50 rounded-lg p-4 border border-gray-700">
                            <h4 className="font-bold text-amber-400 mb-3">The CWF v2 Formula</h4>
                            <div className="font-mono text-sm space-y-1">
                                <p>ISF  = AMP_max / AMP_current              <span className="text-gray-500">← inflation scarcity (primary)</span></p>
                                <p>GCF  = gas_ETH / gas_chain                <span className="text-gray-500">← gas economic effort (primary)</span></p>
                                <p>PF   = (price_chain_EMA7 / price_ETH_EMA7)^{PRICE_FACTOR_CONFIG.exponent} <span className="text-gray-500">← supply/price scarcity (secondary)</span></p>
                                <p className="mt-1 border-t border-gray-700 pt-1">CWF  = normalize( ISF × GCF × PF )  <span className="text-gray-500">← ETH = 1.0 always</span></p>
                            </div>
                        </div>

                        <div className="bg-cyan-500/10 border border-cyan-500/30 rounded-lg p-4">
                            <h5 className="font-bold text-cyan-400 mb-2">💰 Price Factor (PF) — The Supply Flywheel</h5>
                            <p className="text-sm text-gray-300 mb-3">
                                As you and others burn XEN on a chain, supply decreases. According to basic economics, lower supply → higher price.
                                A higher price means burning that XEN represents a greater economic sacrifice — and the PF rewards exactly that.
                            </p>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs text-center">
                                <div className="bg-black/30 rounded p-2">
                                    <p className="text-green-400 font-bold">Burns increase →</p>
                                    <p className="text-gray-400">Supply drops</p>
                                </div>
                                <div className="bg-black/30 rounded p-2">
                                    <p className="text-amber-400 font-bold">Supply drops →</p>
                                    <p className="text-gray-400">XEN price rises</p>
                                </div>
                                <div className="bg-black/30 rounded p-2">
                                    <p className="text-purple-400 font-bold">Price rises →</p>
                                    <p className="text-gray-400">PF rises → more XNT</p>
                                </div>
                            </div>
                            <div className="mt-3 text-xs text-gray-500 space-y-1">
                                <p>• <strong className="text-gray-400">7-epoch EMA</strong>: smooths out short-term price spikes and manipulation attempts</p>
                                <p>• <strong className="text-gray-400">^{PRICE_FACTOR_CONFIG.exponent} dampening</strong>: price is secondary to AMP and gas — never overrides them</p>
                                <p>• <strong className="text-gray-400">Cap [{`1/${PRICE_FACTOR_CONFIG.maxImpact}×, ${PRICE_FACTOR_CONFIG.maxImpact}×`}]</strong>: PF can never crash or explode your score</p>
                                <p>• <strong className="text-gray-400">PF = 1.0 fallback</strong>: if price data is unavailable (PulseChain, API failure), no penalty applied</p>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
                                <h5 className="font-bold text-blue-400 mb-2">Inflation Scarcity (ISF)</h5>
                                <p className="text-sm">
                                    XEN uses an AMP (Amplifier) that starts at 3,000 and drops by 1 every day.
                                    A lower AMP means fewer XEN are minted per mint-day — making existing tokens more scarce.
                                    Optimism's XEN already reached AMP=1 (near-deflationary), so opXEN is close to ETH-XEN in value.
                                    Polygon's AMP is still very high, so mXEN is abundant and its CWF is low (0.010).
                                </p>
                            </div>
                            <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-4">
                                <h5 className="font-bold text-purple-400 mb-2">Gas Cost Factor (GCF)</h5>
                                <p className="text-sm">
                                    Minting XEN on Ethereum costs significantly more gas than minting on Polygon.
                                    Higher gas cost = more economic effort per token = higher weight in the score.
                                    GCF adjusts for this so that a Polygon burn at 100× more tokens still reflects
                                    the real economic effort behind it.
                                </p>
                            </div>
                        </div>

                        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                            <h5 className="font-bold text-amber-400 mb-2">Practical Example</h5>
                            <div className="text-sm space-y-1 font-mono">
                                <p>Burn 1,000,000 ETH-XEN  → xenNorm = 1,000,000 × 1.000 = 1,000,000 → √ = 1,000 pts base</p>
                                <p>Burn 1,000,000 mXEN     → xenNorm = 1,000,000 × 0.010 =    10,000 → √ =   100 pts base</p>
                                <p>To match ETH score in Polygon: burn ~100,000,000 mXEN</p>
                            </div>
                            <p className="text-xs text-gray-500 mt-2">
                                CWF v2 (ISF × GCF × PF) is recalculated each epoch. Full snapshot — including PF and price EMA per chain — is published in <code>proofs.json</code> for complete verifiability.
                            </p>
                        </div>
                    </div>
                </Section>

                {/* ═══════════════════════════════════════════════════════════════ */}
                {/*                   SECTION 9.5: STREAK FLYWHEEL                  */}
                {/* ═══════════════════════════════════════════════════════════════ */}
                <Section id="streak" title="9.5. Streak Flywheel — Consistency Rewards" icon={TrendingUp}>
                    <div className="space-y-6 text-gray-300">
                        <p>
                            Pilots who burn XEN in <strong className="text-amber-400">consecutive epochs</strong> earn a Streak Multiplier
                            that increases their proportional share of the epoch budget — at no extra cost to the protocol.
                            Streak bonuses redistribute <em>within</em> the fixed budget; no new XNT is created.
                        </p>

                        <div className="bg-black/50 rounded-lg p-4 border border-gray-700">
                            <h4 className="font-bold text-amber-400 mb-3">Streak Formula</h4>
                            <p className="font-mono text-sm text-center">
                                Streak_Mult = 1 + min({STREAK_CONFIG.multiplierCap}, {STREAK_CONFIG.logCoefficient} × log₂(streakEpochs + 1))
                            </p>
                        </div>

                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left border-b border-gray-700">
                                        <th className="pb-3 pr-4">Consecutive Epochs</th>
                                        <th className="pb-3 pr-4">Multiplier</th>
                                        <th className="pb-3">Bonus</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {[0, 1, 2, 3, 5, 7].map(epochs => {
                                        const mult = getStreakMultiplier(epochs);
                                        return (
                                            <tr key={epochs} className="border-b border-gray-800">
                                                <td className="py-2 pr-4">{epochs === 0 ? '0 (no streak)' : `${epochs}`}</td>
                                                <td className="py-2 pr-4 font-mono text-amber-400">{mult.toFixed(3)}×</td>
                                                <td className={`py-2 font-bold ${epochs >= 7 ? 'text-amber-400' : 'text-green-400'}`}>
                                                    {epochs === 0 ? '—' : `+${((mult - 1) * 100).toFixed(1)}%`}
                                                    {epochs >= 7 && ' 🏆 (cap)'}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
                                <h5 className="font-bold text-green-400 mb-2">✅ Break Rules (Forgiving)</h5>
                                <ul className="text-sm space-y-1">
                                    <li>• Miss <strong>1 epoch</strong>: streak = floor(streak ÷ 2)</li>
                                    <li>• Miss <strong>2+ epochs</strong>: streak resets to 0</li>
                                    <li>Life happens — one miss doesn't erase your history</li>
                                </ul>
                            </div>
                            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4">
                                <h5 className="font-bold text-yellow-400 mb-2">⚡ Minimum Burn (Dust Guard)</h5>
                                <p className="text-sm">
                                    A burn only qualifies for streak if <code className="text-yellow-300">√(xenNorm) ≥ {STREAK_CONFIG.minRawScore}</code>.
                                    This prevents dust burns from gaming the streak without real economic contribution.
                                </p>
                            </div>
                        </div>

                        <div className="bg-black/50 rounded-lg p-4 border border-gray-700">
                            <h5 className="font-bold text-amber-400 mb-3">Minimum XEN per Chain (at seed CWF)</h5>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                                {EVM_CHAINS.map(chainKey => (
                                    <div key={chainKey} className="bg-black/30 rounded p-2 text-center">
                                        <p className="text-white capitalize">{chainKey}</p>
                                        <p className="text-amber-400 font-mono">≥ {getStreakMinXenForChain(chainKey).toLocaleString()} XEN</p>
                                    </div>
                                ))}
                            </div>
                            <p className="text-xs text-gray-500 mt-2">Auto-calibrated by CWF each epoch. As CWF changes, minimums adjust proportionally — no hardcoded per-chain values.</p>
                        </div>
                    </div>
                </Section>

                {/* ═══════════════════════════════════════════════════════════════ */}
                {/*                  SECTION 9.7: SOLVENCY GUARANTEES               */}
                {/* ═══════════════════════════════════════════════════════════════ */}
                <Section id="solvency" title="9.7. Solvency Guarantees — Mathematical Proof" icon={ShieldCheck}>
                    <div className="space-y-6 text-gray-300">
                        <p>
                            Moon Forge is designed so the vault can <strong className="text-green-400">never run dry through normal operation</strong>.
                            Every reward layer has hard mathematical bounds that have been formally verified.
                        </p>

                        <div className="space-y-3">
                            <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
                                <h5 className="font-bold text-green-400 mb-2">Layer 1 — Oracle Budget (Safety Factor 0.90)</h5>
                                <p className="font-mono text-sm text-center bg-black/30 rounded p-2">
                                    epochBudget = pool_balance × 0.90
                                </p>
                                <p className="text-sm mt-2">10% is always held in reserve, regardless of epoch size.</p>
                            </div>

                            <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
                                <h5 className="font-bold text-green-400 mb-2">Layer 2 — Artifact Boost Capacity</h5>
                                <div className="font-mono text-xs space-y-0.5 bg-black/30 rounded p-2">
                                    <p>600 Lunar Dust   × +5%  = 3,000 boost-units</p>
                                    <p>300 Cosmic Shard × +10% = 3,000 boost-units</p>
                                    <p>90  Solar Core   × +20% = 1,800 boost-units</p>
                                    <p>10  Void Anomaly × +50% =   500 boost-units</p>
                                    <p className="border-t border-gray-700 pt-1 text-amber-400">Worst-case: +8.3% extra per pilot → Reserve 10% ≥ 8.3% ✅</p>
                                </div>
                            </div>

                            <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
                                <h5 className="font-bold text-green-400 mb-2">Layer 3 — Proportional Distribution Identity</h5>
                                <p className="font-mono text-sm text-center bg-black/30 rounded p-2">
                                    Σ(pilot_score / total_scores) = 1.0  →  Σ(allocations) = epochBudget
                                </p>
                                <p className="text-sm mt-2">
                                    All multipliers (Tier, NFT, Streak, PF) adjust proportions — they never create new XNT.
                                    Total paid is always exactly <code>epochBudget</code>.
                                </p>
                            </div>

                            <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
                                <h5 className="font-bold text-blue-400 mb-2">Economic Incentive Condition</h5>
                                <p className="text-sm">
                                    For Moon Forge to remain attractive, burning XEN must yield more XNT value than selling XEN and buying XNT on the open market.
                                    The PF flywheel helps maintain this: as early burners reduce supply, XEN price rises, making future burns yield more proportional score.
                                    Early participants are structurally advantaged — they burn before the price (and PF) rises.
                                </p>
                            </div>
                        </div>
                    </div>
                </Section>

                {/* ═══════════════════════════════════════════════════════════════ */}
                {/*                    SECTION 10: MOON PARTY                       */}
                {/* ═══════════════════════════════════════════════════════════════ */}
                <Section id="moonparty" title="10. Moon Party — Potential Eligibility" icon={Globe}>
                    <div className="space-y-4 text-gray-300">
                        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                            <div className="flex items-start gap-2">
                                <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                                <p className="text-sm text-amber-300 font-medium">
                                    Important: The X1 "Moon Party" rules are not officially confirmed.
                                    Information about eligibility criteria has changed before and may change again.
                                    Nothing in this section is guaranteed.
                                </p>
                            </div>
                        </div>

                        <p>
                            Moon Forge burns XEN permanently on-chain. These burns are real, verifiable, and recorded
                            on each chain's public blockchain — forever.
                        </p>

                        <h4 className="font-bold text-white">What This Could Mean</h4>
                        <p className="text-sm">
                            If the X1 ecosystem or any future XEN program considers on-chain burn history as part
                            of eligibility criteria, Moon Forge pilots will already have verifiable proof of their burns.
                            This is not a feature we control — it depends entirely on decisions made by third parties.
                        </p>

                        <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
                            <h5 className="font-bold text-gray-300 mb-2">What We Know For Sure</h5>
                            <ul className="text-sm space-y-1">
                                <li className="flex items-start gap-2">
                                    <span className="text-green-400">✓</span>
                                    <span>Your XEN burns are real and permanent on the respective EVM chains</span>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-green-400">✓</span>
                                    <span>You receive XNT rewards on X1 through Moon Forge's Merkle proof system</span>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-green-400">✓</span>
                                    <span>All burn transactions are publicly verifiable on-chain</span>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="text-red-400">✗</span>
                                    <span>We cannot guarantee any additional eligibility beyond the XNT rewards this protocol provides</span>
                                </li>
                            </ul>
                        </div>

                        <p className="text-xs text-gray-500">
                            Follow official X1 and XEN community channels for any announcements about Moon Party or
                            burn-based eligibility programs. Moon Forge is a community-built protocol and is NOT
                            affiliated with the official X1 team.
                        </p>
                    </div>
                </Section>

                {/* ═══════════════════════════════════════════════════════════════ */}
                {/*                    SECTION 11: RISKS                            */}
                {/* ═══════════════════════════════════════════════════════════════ */}
                <Section id="risks" title="11. Risks & Disclaimers" icon={AlertTriangle}>
                    <div className="space-y-6 text-gray-300">
                        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
                            <h4 className="font-bold text-red-400 mb-2">🔴 Smart Contract Risk</h4>
                            <p className="text-sm">
                                While audited, smart contracts may contain bugs. Only burn what you can afford to lose.
                            </p>
                        </div>

                        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
                            <h4 className="font-bold text-red-400 mb-2">🔴 Oracle Centralization</h4>
                            <p className="text-sm">
                                The Oracle server is currently operated by the protocol team. While all proofs are verifiable,
                                the Oracle could theoretically go offline. Community governance for the Oracle is planned.
                            </p>
                        </div>

                        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
                            <h4 className="font-bold text-red-400 mb-2">🔴 X1 Chain Risk</h4>
                            <p className="text-sm">
                                XNT rewards are on X1. If X1 fails or is abandoned, your XNT may become worthless.
                                Moon Forge is NOT affiliated with the X1 team.
                            </p>
                        </div>

                        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                            <h4 className="font-bold text-amber-400 mb-2">⚠️ Price Volatility</h4>
                            <p className="text-sm">
                                Both XEN and XNT prices are volatile. The value of your rewards may change significantly.
                            </p>
                        </div>

                        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                            <h4 className="font-bold text-amber-400 mb-2">⚠️ Permanence</h4>
                            <p className="text-sm">
                                Burning XEN is <strong>permanent and irreversible</strong>.
                                There is no undo button. Think carefully before burning.
                            </p>
                        </div>
                    </div>
                </Section>

                {/* ═══════════════════════════════════════════════════════════════ */}
                {/*                    SECTION 10: FAQ                              */}
                {/* ═══════════════════════════════════════════════════════════════ */}
                <Section id="faq" title="12. Frequently Asked Questions" icon={HelpCircle}>
                    <div className="space-y-4 text-gray-300">
                        <FAQItem
                            q="Does XNT auto-transfer to my wallet?"
                            a="NO. You must manually claim on Mission Control. Rewards vest linearly over your tier duration."
                        />
                        <FAQItem
                            q="Can I have multiple missions at once?"
                            a="YES. You can burn multiple times and have multiple active missions with different tiers."
                        />
                        <FAQItem
                            q="What happens if I eject early?"
                            a="You lose the penalty percentage (20% for Orbit, 50% for Moon Landing) of your REMAINING unvested balance. 93.5% of that penalty returns to the reward pool for other pilots."
                        />
                        <FAQItem
                            q="When should I equip the NFT?"
                            a="BEFORE burning. The boost is applied at burn time and cannot be added later."
                        />
                        <FAQItem
                            q="Can I sell my NFT while it's equipped?"
                            a="NO. The NFT is locked during your mission. It returns when you complete or eject."
                        />
                        <FAQItem
                            q="How often are epochs calculated?"
                            a="Every 7 days. The Oracle publishes Merkle proofs after each epoch closes."
                        />
                        <FAQItem
                            q="Why does burning more XEN on Polygon score less than the same amount on Ethereum?"
                            a="Because of CWF (Chain Weight Factor). Polygon mXEN has a very high supply and low minting cost compared to ETH-XEN. CWF normalises this economic difference — burning the equivalent economic effort on any chain gives roughly the same score."
                        />
                        <FAQItem
                            q="Does Moon Forge guarantee Moon Party eligibility?"
                            a="No. Moon Forge cannot guarantee any third-party program's eligibility criteria. Your burns are real and verifiable on-chain, which is an objective fact regardless of what any future program decides."
                        />
                        <FAQItem
                            q="Is there a minimum burn amount?"
                            a="No minimum, but very small burns may not be economical due to gas costs."
                        />
                        <FAQItem
                            q="Do burns from different epochs compete with each other?"
                            a="NO. Each 7-day epoch is completely isolated. You only compete with pilots who burned in the same epoch window. Late burners get their own separate budget — they never dilute earlier participants."
                        />
                        <FAQItem
                            q="If I donate XNT, how much goes to the pool?"
                            a="100%. The donate() function in MoonForgeBase.sol is the only action with zero fee split. It accepts XNT, emits a Donated event, and the full amount stays in the contract balance (= the reward pool). Verifiable on any X1 block explorer."
                        />
                        <FAQItem
                            q="Why does the NFT fee split (1.5% architect) differ from the penalty split (3.5% dev)?"
                            a="They are governed by separate contracts (MoonArtifacts.sol and MoonForgeBase.sol) with independently set parameters. Both are intentional. NFT sales have a smaller dev/architect share (1.5%) because the pool gets more (95.5%). Penalty splits have a larger dev share (3.5%) because the total penalty pool is a different economic context."
                        />
                    </div>
                </Section>

                {/* ═══════════════════════════════════════════════════════════════ */}
                {/*                    SECTION 11: GLOSSARY                         */}
                {/* ═══════════════════════════════════════════════════════════════ */}
                <Section id="glossary" title="13. Glossary" icon={Book}>
                    <div className="space-y-4 text-gray-300">
                        <GlossaryItem term="XEN" def="The token being burned. Exists on multiple EVM chains (ETH-XEN, opXEN, bXEN, mXEN, aXEN, baseXEN, PLS-XEN)." />
                        <GlossaryItem term="XNT" def="The reward token on X1 blockchain (9 decimals). Earned by burning XEN through Moon Forge." />
                        <GlossaryItem term="CWF" def="Chain Weight Factor v2 — normalize(ISF × GCF × PF). Normalises burns across chains by economic effort. ETH = 1.0 anchor. Recalculated every epoch." />
                        <GlossaryItem term="ISF" def="Inflation Scarcity Factor — AMP_max / AMP_current. Captures how deflationary XEN is on each chain. Primary CWF component." />
                        <GlossaryItem term="GCF" def="Gas Cost Factor — gas_ETH / gas_chain. Captures the real economic effort (gas) to produce XEN on each chain. Primary CWF component." />
                        <GlossaryItem term="PF" def="Price Factor — (price_chain_EMA7 / price_ETH_EMA7)^0.33. Captures XEN market price relative to ETH-XEN. Secondary CWF component. Creates burn-supply-price flywheel." />
                        <GlossaryItem term="AMP" def="XEN Amplifier — starts at 3,000 and drops 1 per day (time-based only, unaffected by burns). Lower AMP = higher ISF = more valuable burns." />
                        <GlossaryItem term="EMA" def="Exponential Moving Average — 7-epoch rolling price average used by PF to smooth out manipulation and volatility." />
                        <GlossaryItem term="Forge Score" def="√(XEN × CWF) × Tier × NFT × Streak — determines your proportional share of the epoch reward pool." />
                        <GlossaryItem term="xenNorm" def="XEN_burned × CWF — the CWF-normalised burn amount used inside the square root." />
                        <GlossaryItem term="Streak Multiplier" def="1.0× to 1.15× bonus for burning in consecutive epochs. Earned after 1 epoch (+5%), cap at 7+ epochs (+15%). Miss 1 epoch: halved. Miss 2+: reset." />
                        <GlossaryItem term="Epoch" def="A 7-day period during which all burns are collected, scored, and turned into Merkle proofs." />
                        <GlossaryItem term="epochBudget" def="pool_balance × 0.90 — XNT available for distribution in one epoch. 10% held as Artifact boost reserve." />
                        <GlossaryItem term="Vesting" def="The linear release of your XNT rewards over your tier's duration." />
                        <GlossaryItem term="Eject" def="Emergency exit from a mission. Applies a tier penalty (20% or 50%) to unvested balance." />
                        <GlossaryItem term="Oracle" def="Off-chain service that calculates CWF v2, scores, streak counters, Merkle proofs, and publishes to X1 SVM." />
                        <GlossaryItem term="proofs.json" def="Published by Oracle each epoch. Contains individual Merkle proofs, CWF snapshot, PF snapshot (with price EMA per chain), and streak info per pilot." />
                        <GlossaryItem term="Merkle Proof" def="Cryptographic proof that your allocation is included in the epoch root — used to claim XNT." />
                        <GlossaryItem term="Artifact" def="Optional boost NFT. Equipped before burning to increase your Forge Score by 5–50%." />
                        <GlossaryItem term="Void Anomaly" def="Rarest Artifact (+50% boost, supply 10). Recommended for Moon Landing pilots." />
                        <GlossaryItem term="Portal" def="The smart contract on each EVM chain where XEN is burned." />
                        <GlossaryItem term="Base" def="The smart contract on X1 where XNT rewards are vested and claimed." />
                        <GlossaryItem term="Donation" def="A direct contribution of XNT to the reward pool via donate(). 100% goes to the pool — no fee split of any kind. Emits a Donated event for full on-chain transparency." />
                        <GlossaryItem term="Epoch Isolation" def="Each 7-day epoch is a fully independent distribution cycle. Burns in Epoch N only compete with other burns in Epoch N — never with Epoch N+1 or earlier." />
                        <GlossaryItem term="NFT Floor Price" def="The minimum price an Artifact can reach via decay. Enforced by contract — equal to the original base price at deployment (e.g. 5 XNT for Cosmic Shard). Price can never fall below this floor." />
                    </div>
                </Section>

                {/* ═══════════════════════════════════════════════════════════════ */}
                {/*                    SECTION 13: DONATIONS                        */}
                {/* ═══════════════════════════════════════════════════════════════ */}
                <Section id="donations" title="15. Donations — 100% to Reward Pool" icon={Heart}>
                    <div className="space-y-6 text-gray-300">
                        <p>
                            Donations are the <strong className="text-green-400">only funding stream with zero deductions</strong>.
                            No fee split. No oracle share. No dev share. Every XNT donated goes entirely to the reward pool.
                        </p>

                        {/* Guarantee box */}
                        <div className="bg-green-500/10 border border-green-500/40 rounded-lg p-5">
                            <h4 className="font-bold text-green-400 mb-3 flex items-center gap-2">
                                <CheckCircle className="w-5 h-5" /> On-Chain Guarantee
                            </h4>
                            <p className="text-sm mb-3">
                                The <code className="text-green-300">donate()</code> function in <code className="text-green-300">MoonForgeBase.sol</code> is
                                mathematically incapable of splitting funds:
                            </p>
                            <div className="bg-black/60 rounded-lg p-3 font-mono text-sm text-green-300 border border-green-500/30">
                                <div className="text-gray-500 mb-1">// MoonForgeBase.sol — exactly what happens:</div>
                                <div>function donate() external payable {'{'}</div>
                                <div className="pl-4">require(msg.value {'>'} 0, "Donation must be {'>'} 0");</div>
                                <div className="pl-4 text-green-400">emit Donated(msg.sender, msg.value);</div>
                                <div className="pl-4 text-gray-500">// msg.value stays in contract = reward pool</div>
                                <div>{'}'}</div>
                            </div>
                            <p className="text-xs text-gray-400 mt-2">
                                No transfer() calls. No fee deductions. The balance stays in the contract, which <em>is</em> the reward pool.
                                Any blockchain explorer can verify this by inspecting the function bytecode.
                            </p>
                        </div>

                        {/* Comparison */}
                        <h4 className="font-bold text-white">All Pool Funding Streams Compared</h4>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left border-b border-gray-700">
                                        <th className="pb-3 pr-4">Source</th>
                                        <th className="pb-3 pr-4 text-green-400">Pool Gets</th>
                                        <th className="pb-3">Deductions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr className="border-b border-gray-800">
                                        <td className="py-3 pr-4 text-green-400 font-bold">💚 Donation</td>
                                        <td className="py-3 pr-4 font-bold text-green-400">100%</td>
                                        <td className="py-3 text-gray-500">None — zero fees guaranteed</td>
                                    </tr>
                                    <tr className="border-b border-gray-800">
                                        <td className="py-3 pr-4">Early-exit penalty</td>
                                        <td className="py-3 pr-4 text-green-300">93.5%</td>
                                        <td className="py-3 text-gray-400">6.5% oracle/referrer/dev</td>
                                    </tr>
                                    <tr className="border-b border-gray-800">
                                        <td className="py-3 pr-4">NFT Artifact sale</td>
                                        <td className="py-3 pr-4 text-green-300">95.5%</td>
                                        <td className="py-3 text-gray-400">4.5% oracle/referrer/architect</td>
                                    </tr>
                                    <tr>
                                        <td className="py-3 pr-4">Game fees</td>
                                        <td className="py-3 pr-4 text-green-300">100%</td>
                                        <td className="py-3 text-gray-400">None (fees extracted from bets before pool)</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        {/* Transparency note */}
                        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
                            <h5 className="font-bold text-blue-400 mb-2">🔍 Verifiable Transparency</h5>
                            <p className="text-sm">
                                Every donation emits a <code className="text-blue-300">Donated(address donor, uint256 amount)</code> event
                                on the X1 blockchain. Anyone can inspect the X1 explorer and see:
                            </p>
                            <ul className="text-sm mt-2 space-y-1">
                                <li>• Who donated, how much, and when</li>
                                <li>• That no XNT left the contract (no outgoing transfer in the same tx)</li>
                                <li>• The contract balance before and after (= pool balance)</li>
                            </ul>
                        </div>

                        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                            <h5 className="font-bold text-amber-400 mb-2">Who Should Donate?</h5>
                            <ul className="text-sm space-y-1">
                                <li>• Community members who believe in the protocol long-term</li>
                                <li>• Projects that want to boost XNT rewards for their users</li>
                                <li>• Anyone who received value from the protocol and wants to give back</li>
                                <li>• Ecosystem funds supporting the X1 and XEN communities</li>
                            </ul>
                        </div>
                    </div>
                </Section>

                {/* ═══════════════════════════════════════════════════════════════ */}
                {/*                    SECTION 12: GAMING                           */}
                {/* ═══════════════════════════════════════════════════════════════ */}
                <Section id="gaming" title="14. Gaming & Tokenomics Loop" icon={Gamepad2}>
                    <div className="space-y-6 text-gray-300">
                        <p>
                            Moon Forge Games are not just for fun—they are <strong className="text-amber-400">Yield Engines</strong> designed to pump value into the XNT Reward Pool.
                        </p>

                        <div className="bg-black/50 rounded-lg p-4 border border-gray-700">
                            <h4 className="font-bold text-white mb-3">The "Flywheel" Effect</h4>
                            <p className="text-sm mb-4">
                                Every time a game is played, a portion of the pot is extracted and sent to the <strong>Main Reward Pool</strong>.
                                This means <strong className="text-green-400">Gamers pay Burners</strong>.
                            </p>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                                <div className="p-3 bg-red-900/20 border border-red-500/30 rounded">
                                    <div className="font-bold text-red-400 mb-1">Direct Burn</div>
                                    <p>Lottery ticket sales are <strong>20% burned</strong> immediately, reducing XNT supply.</p>
                                </div>
                                <div className="p-3 bg-green-900/20 border border-green-500/30 rounded">
                                    <div className="font-bold text-green-400 mb-1">Fee Injection</div>
                                    <p>Coin Flip & High-Low fees (2-4%) are injected directly into the next Epoch's reward pool.</p>
                                </div>
                            </div>
                        </div>

                        <h4 className="font-bold text-white mt-4">Game Fee Structure</h4>
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left border-b border-gray-700">
                                        <th className="pb-2">Game</th>
                                        <th className="pb-2">Type</th>
                                        <th className="pb-2">Protocol Fee</th>
                                        <th className="pb-2">Destination</th>
                                    </tr>
                                </thead>
                                <tbody className="text-gray-400">
                                    <tr className="border-b border-gray-800">
                                        <td className="py-2 text-white">Coin Flip</td>
                                        <td className="py-2">PvH (House)</td>
                                        <td className="py-2 text-amber-400">3.5%</td>
                                        <td className="py-2">Reward Pool</td>
                                    </tr>
                                    <tr className="border-b border-gray-800">
                                        <td className="py-2 text-white">Jackpot</td>
                                        <td className="py-2">Multiplayer</td>
                                        <td className="py-2 text-amber-400">5.0%</td>
                                        <td className="py-2">Reward Pool</td>
                                    </tr>
                                    <tr className="border-b border-gray-800">
                                        <td className="py-2 text-white">Lottery</td>
                                        <td className="py-2">Raffle</td>
                                        <td className="py-2 text-red-400">20.0%</td>
                                        <td className="py-2">🔥 BURN ADDRESS</td>
                                    </tr>
                                    <tr className="border-b border-gray-800">
                                        <td className="py-2 text-white">Duel</td>
                                        <td className="py-2">PvP</td>
                                        <td className="py-2 text-amber-400">2.5%</td>
                                        <td className="py-2">Reward Pool</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg p-4">
                            <h5 className="font-bold text-purple-400 mb-2">Sustainable APY</h5>
                            <p className="text-sm">
                                Unlike inflationary tokens that print rewards from thin air, XNT yield comes from
                                <strong className="text-white"> real economic activity</strong>. As game volume grows,
                                the APY for XEN Burners increases organically.
                            </p>
                        </div>
                    </div>
                </Section>

                {/* Section 16 — Strategy Guide */}
                <Section id="strategy" title="Pilot Strategy Guide — When to Burn, What to Buy, How to Win" icon={Lightbulb}>
                    <div className="space-y-6 text-gray-300">

                        {/* Intro */}
                        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                            <p className="text-sm">
                                <strong className="text-amber-400">This guide is fully transparent.</strong> Moon Forge has no house edge over pilots —
                                every XNT in the pool came from real XEN burns, penalties, donations, NFT sales, or game fees.
                                Understanding how the math works lets you make <strong className="text-white">informed choices</strong> rather than guesses.
                            </p>
                        </div>

                        {/* ── 1. Choosing Your Tier ── */}
                        <h3 className="font-bold text-white text-lg border-b border-gray-700 pb-2">1. Choosing Your Mission Tier</h3>
                        <p className="text-sm">
                            Your tier multiplier amplifies your <strong className="text-white">Forge Score</strong> —
                            which determines your proportional share of the epoch's XNT budget. A higher tier means a higher score,
                            but also a longer lock-up and a penalty if you exit early.
                        </p>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            {TIERS.map(tier => (
                                <div key={tier.id} className="bg-black/50 border border-gray-700 rounded-lg p-4">
                                    <div className="flex items-center gap-2 mb-2">
                                        <Lock className="w-4 h-4 text-amber-400" />
                                        <span className="font-bold text-white">{tier.name}</span>
                                    </div>
                                    <div className="space-y-1 text-sm">
                                        <div className="flex justify-between"><span className="text-gray-400">Lock</span><span className="text-white">{tier.duration} days</span></div>
                                        <div className="flex justify-between"><span className="text-gray-400">Multiplier</span><span className="text-green-400">{tier.multiplier}×</span></div>
                                        <div className="flex justify-between"><span className="text-gray-400">Early-exit penalty</span><span className="text-red-400">{tier.penalty}%</span></div>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Real Example */}
                        <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-4">
                            <h5 className="font-bold text-amber-400 mb-3 flex items-center gap-2">
                                <Calculator className="w-4 h-4" /> Real Example: Same burn, 3 different tiers
                            </h5>
                            <p className="text-xs text-gray-400 mb-3">
                                Pilot burns 10,000,000 XEN on Ethereum (CWF = 1.0). Epoch pool = 5,000 XNT. 3 pilots total, each with the same burn but different tiers.
                            </p>
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="text-left text-gray-400 border-b border-gray-700 text-xs">
                                            <th className="pb-2">Tier</th>
                                            <th className="pb-2">Score formula</th>
                                            <th className="pb-2">Score</th>
                                            <th className="pb-2">Share</th>
                                            <th className="pb-2">XNT earned</th>
                                            <th className="pb-2">Lock</th>
                                        </tr>
                                    </thead>
                                    <tbody className="text-gray-300 text-xs">
                                        <tr className="border-b border-gray-800">
                                            <td className="py-2 text-white">Launchpad</td>
                                            <td className="py-2">√10M × 1.0×</td>
                                            <td className="py-2">3,162</td>
                                            <td className="py-2">16.7%</td>
                                            <td className="py-2 text-green-400">835 XNT</td>
                                            <td className="py-2">5 days</td>
                                        </tr>
                                        <tr className="border-b border-gray-800">
                                            <td className="py-2 text-white">Orbit</td>
                                            <td className="py-2">√10M × 2.0×</td>
                                            <td className="py-2">6,325</td>
                                            <td className="py-2">33.3%</td>
                                            <td className="py-2 text-green-400">1,665 XNT</td>
                                            <td className="py-2">45 days</td>
                                        </tr>
                                        <tr>
                                            <td className="py-2 text-white">Moon Landing</td>
                                            <td className="py-2">√10M × 3.0×</td>
                                            <td className="py-2">9,487</td>
                                            <td className="py-2">50.0%</td>
                                            <td className="py-2 text-green-400">2,500 XNT</td>
                                            <td className="py-2">180 days</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                            <p className="text-xs text-gray-500 mt-2">
                                * All three together sum to 100%. The epoch budget (here 5,000 XNT) is split proportionally — no XNT is wasted.
                            </p>
                        </div>

                        <div className="space-y-2 text-sm">
                            <p className="flex items-start gap-2"><span className="text-green-400 font-bold flex-shrink-0">✅ Launchpad is best when:</span><span>You want to test the protocol, you're uncertain about price, or you need liquidity within 5 days. Lower multiplier = smaller share, but no lock risk.</span></p>
                            <p className="flex items-start gap-2"><span className="text-amber-400 font-bold flex-shrink-0">✅ Orbit is best when:</span><span>You believe in the protocol for 45 days and want 2× amplification. Good balance between reward and flexibility.</span></p>
                            <p className="flex items-start gap-2"><span className="text-blue-400 font-bold flex-shrink-0">✅ Moon Landing is best when:</span><span>You're a long-term holder, you want the maximum multiplier, and you're comfortable locking for 6 months. The 50% early-exit penalty is severe — only use this tier if you're committed.</span></p>
                            <p className="flex items-start gap-2"><span className="text-red-400 font-bold flex-shrink-0">❌ Avoid Moon Landing if:</span><span>You might need XNT before 180 days. Ejecting early loses 50% of your allocation — only 50% returns to you, the rest feeds the pool for other pilots.</span></p>
                        </div>

                        {/* ── 2. Chain Selection ── */}
                        <h3 className="font-bold text-white text-lg border-b border-gray-700 pb-2 mt-2">2. Chain Selection — CWF & Your Effective Burn Value</h3>
                        <p className="text-sm">
                            The <strong className="text-white">CWF (Chain Weight Factor)</strong> normalises burns across chains.
                            Burning 1,000,000 XEN on Ethereum is worth <em>much more</em> than burning the same amount on Polygon,
                            because XEN on Ethereum is scarcer (lower supply, higher AMP) and costs more gas.
                        </p>

                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-gray-400 border-b border-gray-700 text-xs">
                                        <th className="pb-2">Chain</th>
                                        <th className="pb-2">CWF (seed)</th>
                                        <th className="pb-2">XEN to match 1M ETH</th>
                                        <th className="pb-2">Best for</th>
                                    </tr>
                                </thead>
                                <tbody className="text-gray-300 text-xs">
                                    {EVM_CHAINS.map(chainKey => {
                                        const chain = CHAINS[chainKey];
                                        const cwf = CWF_DEFAULTS[chainKey];
                                        return (
                                        <tr key={chainKey} className="border-b border-gray-800">
                                            <td className="py-2 text-white font-medium">{chain.name}</td>
                                            <td className="py-2 text-amber-400">{cwf?.toFixed(3) ?? '–'}</td>
                                            <td className="py-2">{cwf ? (1_000_000 / cwf).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '–'} XEN</td>
                                            <td className="py-2 text-gray-400">{chain.chainId === 1 ? 'Max score per XEN' : chain.chainId === 10 ? 'Near-ETH efficiency' : chain.chainId === 43114 ? 'Mid-tier holders' : chain.chainId === 56 ? 'High XEN volume' : 'Massive XEN stacks only'}</td>
                                        </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4 text-sm space-y-2">
                            <p className="flex items-start gap-2"><span className="text-blue-400 font-bold flex-shrink-0">💡 Strategy:</span><span>If you hold XEN on multiple chains, burn the most scarce chain first. 100K XEN on ETH may outperform 10M XEN on Polygon at current CWF seed values.</span></p>
                            <p className="flex items-start gap-2"><span className="text-blue-400 font-bold flex-shrink-0">⚠️ Note:</span><span>CWF is recalculated every epoch based on live AMP and gas data. The values above are seeds — they will drift over time as chains evolve.</span></p>
                        </div>

                        {/* ── 3. NFT Strategy ── */}
                        <h3 className="font-bold text-white text-lg border-b border-gray-700 pb-2 mt-2">3. Artifact NFT Strategy — When to Buy, Which Tier</h3>
                        <p className="text-sm">
                            Artifact NFTs apply a <strong className="text-white">boost multiplier to your final XNT claim</strong> at contract level.
                            They are priced so that <strong className="text-amber-400">1 XNT spent = 1% extra boost</strong> across all tiers — a neutral, fair ratio.
                        </p>

                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-gray-400 border-b border-gray-700 text-xs">
                                        <th className="pb-2">NFT</th>
                                        <th className="pb-2">Price</th>
                                        <th className="pb-2">Boost</th>
                                        <th className="pb-2">Ratio</th>
                                        <th className="pb-2">Break-even allocation</th>
                                        <th className="pb-2">Supply</th>
                                    </tr>
                                </thead>
                                <tbody className="text-gray-300 text-xs">
                                    {ARTIFACT_TIERS.map(a => (
                                        <tr key={a.tier} className="border-b border-gray-800">
                                            <td className="py-2 text-white font-medium">{a.name}</td>
                                            <td className="py-2 text-amber-400">{a.basePrice} XNT</td>
                                            <td className="py-2 text-green-400">+{a.boost}%</td>
                                            <td className="py-2">1 XNT per 1%</td>
                                            <td className="py-2">{(a.basePrice / (a.boost / 100)).toFixed(0)} XNT claim</td>
                                            <td className="py-2 text-gray-400">{a.maxSupply}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-4">
                            <h5 className="font-bold text-amber-400 mb-3 flex items-center gap-2">
                                <Calculator className="w-4 h-4" /> NFT Break-Even Example
                            </h5>
                            <p className="text-xs text-gray-400 mb-2">
                                You buy a <strong className="text-white">Cosmic Shard (10 XNT, +10% boost)</strong>.
                                Your mission would have earned 150 XNT without the NFT.
                                With +10% boost, you earn <strong className="text-green-400">165 XNT</strong> (+15 XNT).
                                You paid 10 XNT for the NFT → <strong className="text-green-400">net profit: +5 XNT</strong>.
                            </p>
                            <p className="text-xs text-gray-400">
                                Break-even: the NFT cost (10 XNT) ÷ boost (10%) = you need at least a <strong className="text-white">100 XNT allocation</strong> to break even.
                                Below that, the NFT is a net loss. Above that, every extra XNT earned is pure profit.
                            </p>
                        </div>

                        <div className="space-y-2 text-sm">
                            <p className="flex items-start gap-2"><span className="text-green-400 font-bold flex-shrink-0">✅ Lunar Dust (5 XNT):</span><span>Best entry point. If your mission is in a small epoch (low competition), even a 5% boost can return multiples. Buy it when the market price is near floor.</span></p>
                            <p className="flex items-start gap-2"><span className="text-amber-400 font-bold flex-shrink-0">✅ Cosmic Shard (10 XNT):</span><span>Dynamic price — buy early (near 10 XNT floor) for best ratio. Good for mid-to-large missions.</span></p>
                            <p className="flex items-start gap-2"><span className="text-blue-400 font-bold flex-shrink-0">✅ Solar Core (20 XNT):</span><span>High-volume pilots who plan multiple Orbit/Moon Landing missions. A +20% boost on a 2,000 XNT claim returns 400 XNT extra for only 20 XNT cost.</span></p>
                            <p className="flex items-start gap-2"><span className="text-purple-400 font-bold flex-shrink-0">✅ Void Anomaly (50 XNT):</span><span>Moon Landing exclusive. If you're locking for 180 days with a large burn, the +50% boost can be worth hundreds of XNT. Only 10 exist — scarcity premium applies.</span></p>
                            <p className="flex items-start gap-2"><span className="text-red-400 font-bold flex-shrink-0">❌ When NOT to buy:</span><span>If current dynamic price is far above floor (e.g. Cosmic Shard at 20 XNT after many sales), recalculate break-even. The 7-day decay will pull the price back down — sometimes waiting is free alpha.</span></p>
                        </div>

                        {/* ── 4. Pool Health ── */}
                        <h3 className="font-bold text-white text-lg border-b border-gray-700 pb-2 mt-2">4. Reading Pool Health Before You Burn</h3>
                        <p className="text-sm">
                            The XNT pool is the source of all rewards. A healthy pool means generous epochs.
                            A depleted pool means lower allocations for everyone.
                        </p>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                            <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
                                <div className="flex items-center gap-2 mb-2">
                                    <ShieldCheck className="w-4 h-4 text-green-400" />
                                    <span className="font-bold text-green-400">Pool is Healthy</span>
                                </div>
                                <ul className="space-y-1 text-xs text-gray-300">
                                    <li>• Pool balance growing epoch-over-epoch</li>
                                    <li>• Donations and NFT sales are active</li>
                                    <li>• Game volume is high</li>
                                    <li>• Few early exits (low penalty flow)</li>
                                </ul>
                                <p className="text-xs text-green-400 mt-2 font-semibold">→ Good time to burn large, long tier</p>
                            </div>
                            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4">
                                <div className="flex items-center gap-2 mb-2">
                                    <AlertTriangle className="w-4 h-4 text-amber-400" />
                                    <span className="font-bold text-amber-400">Pool is Moderate</span>
                                </div>
                                <ul className="space-y-1 text-xs text-gray-300">
                                    <li>• Pool stable but not growing</li>
                                    <li>• Moderate competition this epoch</li>
                                    <li>• Mixed game activity</li>
                                </ul>
                                <p className="text-xs text-amber-400 mt-2 font-semibold">→ Orbit tier is balanced</p>
                            </div>
                            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
                                <div className="flex items-center gap-2 mb-2">
                                    <AlertTriangle className="w-4 h-4 text-red-400" />
                                    <span className="font-bold text-red-400">Pool is Low</span>
                                </div>
                                <ul className="space-y-1 text-xs text-gray-300">
                                    <li>• Pool shrinking over multiple epochs</li>
                                    <li>• Many pilots claiming, few burning</li>
                                    <li>• Launchpad flood (many short timers)</li>
                                </ul>
                                <p className="text-xs text-red-400 mt-2 font-semibold">→ Wait or use Launchpad only</p>
                            </div>
                        </div>

                        <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-4 text-sm">
                            <p className="font-bold text-white mb-2">🔑 Key Insight: Your competition is the epoch, not the protocol</p>
                            <p className="text-xs text-gray-400">
                                Because rewards are <strong className="text-white">proportional</strong>, you don't compete against the protocol — you compete against
                                other pilots in the same epoch. If you're the only Moon Landing pilot this epoch,
                                your 3× multiplier captures a disproportionate share.
                                Monitoring <span className="text-amber-400">current epoch activity</span> in Mission Control
                                gives you a live competitive read before you lock.
                            </p>
                        </div>

                        {/* ── 5. When NOT to burn ── */}
                        <h3 className="font-bold text-white text-lg border-b border-gray-700 pb-2 mt-2">5. When NOT to Burn (Honest Cautions)</h3>

                        <div className="space-y-3">
                            <div className="flex items-start gap-3 bg-red-500/5 border border-red-500/20 rounded-lg p-3">
                                <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                                <div className="text-sm">
                                    <p className="font-bold text-red-400">Don't burn what you can't afford to lock</p>
                                    <p className="text-gray-400 text-xs mt-1">Moon Landing's 50% early-exit penalty is irreversible. If you need that XNT before 180 days, use Launchpad. Only commit funds you genuinely don't need.</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3 bg-red-500/5 border border-red-500/20 rounded-lg p-3">
                                <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                                <div className="text-sm">
                                    <p className="font-bold text-red-400">Don't burn during low-CWF chain floods</p>
                                    <p className="text-gray-400 text-xs mt-1">If hundreds of pilots are burning massive Polygon amounts (CWF = 0.010), they'll still dilute the pool. Monitor the Mission Control epoch view before choosing chain + amount.</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3 bg-red-500/5 border border-red-500/20 rounded-lg p-3">
                                <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                                <div className="text-sm">
                                    <p className="font-bold text-red-400">Don't treat NFT boosts as guaranteed profit</p>
                                    <p className="text-gray-400 text-xs mt-1">NFT boosts increase your claim, but they also increase the total payout obligation. In a very crowded epoch with many boosted pilots, the benefit is real but smaller. The contract reserves 10% of the pool as a buffer — you're protected from vault dry, but boost value scales with pool depth.</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3 bg-red-500/5 border border-red-500/20 rounded-lg p-3">
                                <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                                <div className="text-sm">
                                    <p className="font-bold text-red-400">XNT price is not guaranteed</p>
                                    <p className="text-gray-400 text-xs mt-1">You earn XNT, not USD. XNT market price can go up or down. This is not a savings account — it's a decentralised burn protocol with real market risk.</p>
                                </div>
                            </div>
                        </div>

                        {/* ── 6. Quick-Reference Cheatsheet ── */}
                        <h3 className="font-bold text-white text-lg border-b border-gray-700 pb-2 mt-2">6. Quick Reference Cheatsheet</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                            <div className="bg-black/50 border border-gray-700 rounded-lg p-4">
                                <p className="font-bold text-green-400 mb-2">Best scenarios for Moon Landing (3×)</p>
                                <ul className="space-y-1 text-gray-300">
                                    <li><ArrowRight className="inline w-3 h-3 text-gray-500 mr-1" />Pool balance growing (high donation/game activity)</li>
                                    <li><ArrowRight className="inline w-3 h-3 text-gray-500 mr-1" />Few Moon Landing pilots this epoch (less competition)</li>
                                    <li><ArrowRight className="inline w-3 h-3 text-gray-500 mr-1" />You're burning high-CWF chain (ETH or OP)</li>
                                    <li><ArrowRight className="inline w-3 h-3 text-gray-500 mr-1" />You have a Void Anomaly NFT (+50% extra on already 3× score)</li>
                                    <li><ArrowRight className="inline w-3 h-3 text-gray-500 mr-1" />You're OK holding for 6 months regardless of price</li>
                                </ul>
                            </div>
                            <div className="bg-black/50 border border-gray-700 rounded-lg p-4">
                                <p className="font-bold text-amber-400 mb-2">Best scenarios for Orbit (2×)</p>
                                <ul className="space-y-1 text-gray-300">
                                    <li><ArrowRight className="inline w-3 h-3 text-gray-500 mr-1" />Moderate pool health</li>
                                    <li><ArrowRight className="inline w-3 h-3 text-gray-500 mr-1" />You want amplified rewards but not 6-month lock</li>
                                    <li><ArrowRight className="inline w-3 h-3 text-gray-500 mr-1" />You're a regular participant across multiple epochs</li>
                                    <li><ArrowRight className="inline w-3 h-3 text-gray-500 mr-1" />You hold a Solar Core NFT for the +20% boost</li>
                                </ul>
                            </div>
                            <div className="bg-black/50 border border-gray-700 rounded-lg p-4">
                                <p className="font-bold text-blue-400 mb-2">Best scenarios for Launchpad (1×)</p>
                                <ul className="space-y-1 text-gray-300">
                                    <li><ArrowRight className="inline w-3 h-3 text-gray-500 mr-1" />First time testing the protocol</li>
                                    <li><ArrowRight className="inline w-3 h-3 text-gray-500 mr-1" />Pool health is uncertain</li>
                                    <li><ArrowRight className="inline w-3 h-3 text-gray-500 mr-1" />You need liquidity within 5 days</li>
                                    <li><ArrowRight className="inline w-3 h-3 text-gray-500 mr-1" />You want to participate in the current epoch quickly</li>
                                </ul>
                            </div>
                            <div className="bg-black/50 border border-gray-700 rounded-lg p-4">
                                <p className="font-bold text-purple-400 mb-2">Donation strategy</p>
                                <ul className="space-y-1 text-gray-300">
                                    <li><ArrowRight className="inline w-3 h-3 text-gray-500 mr-1" />100% to pool — no fees, no lock</li>
                                    <li><ArrowRight className="inline w-3 h-3 text-gray-500 mr-1" />Grow the pool before burning (benefits you next epoch)</li>
                                    <li><ArrowRight className="inline w-3 h-3 text-gray-500 mr-1" />Community signal: large donations attract more pilots</li>
                                    <li><ArrowRight className="inline w-3 h-3 text-gray-500 mr-1" />On-chain event (Donated) proves every XNT went to pool</li>
                                </ul>
                            </div>
                        </div>

                    </div>
                </Section>

                {/* Footer */}
                <div className="text-center mt-12 pt-8 border-t border-gray-800">
                    <p className="text-gray-500 text-sm">
                        The Forge is Lit. The choice is yours.
                    </p>
                    <div className="flex justify-center gap-4 mt-4">
                        <a
                            href="https://github.com/xen-moon-forge-protocol/Moon-Forge"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-amber-400 hover:text-amber-300 text-sm flex items-center gap-1"
                        >
                            <ExternalLink className="w-4 h-4" />
                            GitHub
                        </a>
                        <a
                            href="https://github.com/xen-moon-forge-protocol/Moon-Forge/blob/main/docs/WHITEPAPER.md"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-amber-400 hover:text-amber-300 text-sm flex items-center gap-1"
                        >
                            <Book className="w-4 h-4" />
                            Full Document
                        </a>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════
//                              SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════

function StepCard({ step, title, items }: { step: number; title: string; items: string[] }) {
    return (
        <div className="bg-black/50 rounded-lg p-4 border border-gray-700">
            <div className="flex items-center gap-3 mb-3">
                <div className="w-8 h-8 rounded-full bg-gradient-to-r from-amber-500 to-amber-600 flex items-center justify-center text-black font-bold">
                    {step}
                </div>
                <h4 className="font-bold text-white">{title}</h4>
            </div>
            <ul className="space-y-1 text-sm text-gray-300">
                {items.map((item, i) => (
                    <li key={i}>• {item}</li>
                ))}
            </ul>
        </div>
    );
}

function FeeBox({ label, value, color }: { label: string; value: string; color: string }) {
    return (
        <div className="bg-black/50 rounded-lg p-4 text-center border border-gray-700">
            <div className={`text-2xl font-bold ${color}`}>{value}</div>
            <div className="text-sm text-gray-400">{label}</div>
        </div>
    );
}

function FAQItem({ q, a }: { q: string; a: string }) {
    return (
        <div className="bg-black/50 rounded-lg p-4 border border-gray-700">
            <p className="font-bold text-white mb-2">Q: {q}</p>
            <p className="text-gray-300 text-sm">A: {a}</p>
        </div>
    );
}

function GlossaryItem({ term, def }: { term: string; def: string }) {
    return (
        <div className="flex gap-4">
            <span className="font-bold text-amber-400 w-32 flex-shrink-0">{term}</span>
            <span className="text-gray-300">{def}</span>
        </div>
    );
}
