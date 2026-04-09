import React, { useState, useEffect } from 'react';
import { AlertTriangle, X, ExternalLink, Info } from 'lucide-react';

interface RiskWarningProps {
    onAccept: () => void;
    showOnLoad?: boolean;
}

/**
 * RISK WARNING MODAL v8.0
 * Clear disclaimer about pool-based rewards
 */
export default function RiskWarning({ onAccept, showOnLoad = true }: RiskWarningProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [acknowledged, setAcknowledged] = useState(false);

    useEffect(() => {
        // Check if user has already acknowledged
        const hasAcknowledged = localStorage.getItem('moonforge_risk_acknowledged');
        if (!hasAcknowledged && showOnLoad) {
            setIsOpen(true);
        }
    }, [showOnLoad]);

    const handleAccept = () => {
        if (acknowledged) {
            localStorage.setItem('moonforge_risk_acknowledged', 'true');
            setIsOpen(false);
            onAccept();
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
            <div className="max-w-lg w-full bg-gradient-to-b from-gray-900 to-black rounded-2xl border border-amber-500/30 shadow-2xl overflow-hidden">
                {/* Header */}
                <div className="bg-amber-500/10 px-6 py-4 border-b border-amber-500/20">
                    <div className="flex items-center gap-3">
                        <AlertTriangle className="w-8 h-8 text-amber-400" />
                        <div>
                            <h2 className="text-xl font-bold text-amber-400">Risk Disclosure</h2>
                            <p className="text-sm text-gray-400">Please read before participating</p>
                        </div>
                    </div>
                </div>

                {/* Content */}
                <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
                    {/* Main Warning */}
                    <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
                        <div className="flex items-start gap-3">
                            <Info className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                            <div>
                                <h3 className="font-bold text-red-400 mb-2">Important Notice</h3>
                                <p className="text-sm text-gray-300">
                                    Moon Forge is an <strong>experimental protocol</strong>. Rewards are distributed from a
                                    community-funded pool. <strong>ROI is not guaranteed</strong> and depends on pool health
                                    and overall participation.
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Key Points */}
                    <div className="space-y-3">
                        <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider">
                            Key Risks
                        </h3>

                        <div className="space-y-2">
                            <div className="flex items-start gap-2">
                                <span className="text-amber-500">•</span>
                                <p className="text-sm text-gray-300">
                                    <strong className="text-white">Burned tokens are permanently destroyed.</strong> There is no refund mechanism for XEN tokens sent to the burn address.
                                </p>
                            </div>

                            <div className="flex items-start gap-2">
                                <span className="text-amber-500">•</span>
                                <p className="text-sm text-gray-300">
                                    <strong className="text-white">Rewards are variable.</strong> Your actual reward depends on the XNT/XEN exchange rate, pool size, and timing.
                                </p>
                            </div>

                            <div className="flex items-start gap-2">
                                <span className="text-amber-500">•</span>
                                <p className="text-sm text-gray-300">
                                    <strong className="text-white">Early exit penalties apply.</strong> Exiting before your vesting period ends results in a 20-50% penalty.
                                </p>
                            </div>

                            <div className="flex items-start gap-2">
                                <span className="text-amber-500">•</span>
                                <p className="text-sm text-gray-300">
                                    <strong className="text-white">Smart contract risks.</strong> While audited, smart contracts may contain bugs or exploits.
                                </p>
                            </div>

                            <div className="flex items-start gap-2">
                                <span className="text-amber-500">•</span>
                                <p className="text-sm text-gray-300">
                                    <strong className="text-white">NFT scarcity is real.</strong> NFTs are locked during missions and may not be available when you want to buy.
                                </p>
                            </div>
                        </div>
                    </div>

                    {/* Pool Explanation */}
                    <div className="bg-black/40 rounded-lg p-4 border border-gray-700">
                        <h3 className="text-sm font-bold text-white mb-2">How Rewards Work</h3>
                        <p className="text-sm text-gray-400">
                            When you burn XEN, you earn "Forge Points" based on the USD value of your burn.
                            These points determine your share of the XNT reward pool. The pool is funded by:
                        </p>
                        <ul className="mt-2 text-sm text-gray-400 space-y-1">
                            <li>• 95.5% of all NFT sales</li>
                            <li>• 95.5% of early exit penalties</li>
                            <li>• Community donations</li>
                        </ul>
                    </div>

                    {/* External Links */}
                    <div className="flex flex-wrap gap-2">
                        <a
                            href="https://github.com/MoonForge/protocol"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300"
                        >
                            <ExternalLink className="w-3 h-3" />
                            View Source Code
                        </a>
                        <a
                            href="https://docs.moonforge.xyz/risks"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300"
                        >
                            <ExternalLink className="w-3 h-3" />
                            Full Documentation
                        </a>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-6 border-t border-gray-800">
                    {/* Checkbox */}
                    <label className="flex items-start gap-3 mb-4 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={acknowledged}
                            onChange={(e) => setAcknowledged(e.target.checked)}
                            className="mt-1 w-4 h-4 rounded border-gray-600 bg-black/50 text-amber-500 focus:ring-amber-500 focus:ring-offset-0"
                        />
                        <span className="text-sm text-gray-300">
                            I understand that burning XEN is <strong className="text-white">irreversible</strong>,
                            rewards are <strong className="text-white">not guaranteed</strong>, and I am participating
                            at my own risk.
                        </span>
                    </label>

                    {/* Buttons */}
                    <div className="flex gap-3">
                        <button
                            onClick={() => window.history.back()}
                            className="flex-1 px-4 py-3 border border-gray-700 rounded-lg text-gray-400 hover:border-gray-600 hover:text-gray-300 transition-colors"
                        >
                            Go Back
                        </button>
                        <button
                            onClick={handleAccept}
                            disabled={!acknowledged}
                            className={`flex-1 px-4 py-3 rounded-lg font-bold transition-all ${acknowledged
                                    ? 'bg-amber-500 text-black hover:bg-amber-400'
                                    : 'bg-gray-700 text-gray-500 cursor-not-allowed'
                                }`}
                        >
                            I Understand, Continue
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
