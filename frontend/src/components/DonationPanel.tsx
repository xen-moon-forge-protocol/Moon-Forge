/**
 * Moon Forge — Donation Panel
 *
 * Two ways to support the protocol:
 *   1. Pool donation  — 100% to reward vault, mathematically enforced on-chain via Anchor program
 *   2. Dev wallet     — send XNT directly to support infrastructure & Phase 2 development
 *
 * X1 SVM: native token is XNT. No EVM here. X1 Wallet / Backpack required for pool donations.
 */

import { useState } from 'react';
import { Heart, ExternalLink, CheckCircle, AlertTriangle, Loader } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import { parseXNT } from '../lib/constants';

const X1_PROGRAM_ID = ''; // filled after Anchor deploy

export default function DonationPanel() {
    const { x1Connected, x1Address } = useWallet();

    const [amount, setAmount] = useState('');
    const [status, setStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
    const [txHash, setTxHash] = useState<string | null>(null);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    const handleDonate = async () => {
        if (!amount || parseFloat(amount) <= 0) return;
        if (!X1_PROGRAM_ID) {
            setStatus('error');
            setErrorMsg('Anchor program not yet deployed. Pool donations go live at launch.');
            return;
        }

        setStatus('pending');
        setErrorMsg(null);
        setTxHash(null);

        try {
            // X1 runs SVM — donations call the MoonForge Anchor program's donate() instruction
            // x1Address = Base58 Solana public key; XNT is the native token of X1 SVM
            const svmProvider = (window as any).x1 ?? (window as any).backpack?.solana ?? (window as any).solana;
            if (!svmProvider || !x1Address) {
                throw new Error('Connect your X1 Wallet first to donate XNT to the pool.');
            }

            console.log('Pool donation — MoonForge Anchor program on X1 SVM', {
                program: X1_PROGRAM_ID,
                amount: parseXNT(amount).toString(), // lamports (1e9 decimals, SVM)
                donor: x1Address,
            });

            // TODO: wire real Anchor instruction after deploy:
            // const connection = new Connection(X1_RPC_URL);
            // const program = new Program(idl, new PublicKey(X1_PROGRAM_ID), provider);
            // const tx = await program.methods.donate(parseXNT(amount)).rpc();
            throw new Error('Mainnet Anchor program not deployed yet. Donations open at launch.');
        } catch (err: any) {
            setStatus('error');
            setErrorMsg(err.message || 'Transaction failed');
        }
    };

    return (
        <div className="space-y-6">

            {/* ── POOL DONATION ─────────────────────────────────────────────── */}
            <div className="bg-gradient-to-br from-green-900/20 to-emerald-900/20 border border-green-500/30 rounded-xl p-6">
                {/* Header */}
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 bg-green-500/20 rounded-full flex items-center justify-center">
                        <Heart className="w-5 h-5 text-green-400" />
                    </div>
                    <div>
                        <h3 className="font-bold text-white text-lg">Donate to the Reward Pool</h3>
                        <p className="text-green-400 text-sm font-semibold">100% → Pool · Zero Fees · Mathematically Guaranteed</p>
                    </div>
                </div>

                {/* On-chain guarantee */}
                <div className="bg-green-500/10 border border-green-500/40 rounded-lg p-4 mb-6">
                    <div className="flex items-start gap-3">
                        <CheckCircle className="w-5 h-5 text-green-400 shrink-0 mt-0.5" />
                        <div className="text-sm text-gray-300">
                            <p className="font-bold text-green-400 mb-1">Verifiable on-chain — zero trust required</p>
                            <p>
                                The <code className="text-green-300">donate()</code> instruction in the{' '}
                                <code className="text-green-300">MoonForge Anchor program</code> does exactly one
                                thing: transfer XNT into the reward vault PDA and emit a{' '}
                                <code className="text-green-300">Donated</code> event. No fee split code runs.
                                No dev wallet. No oracle share. 100% reaches the pool that pays out pilots.
                                Read the source — it's 3 lines of Rust.
                            </p>
                        </div>
                    </div>
                </div>

                {/* Why donate? */}
                <div className="mb-6 p-4 bg-black/30 rounded-lg border border-white/5">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Why donate to the pool?</p>
                    <ul className="text-sm text-gray-300 space-y-1">
                        <li>🔥 Every XNT you add is distributed to all patient pilots at epoch end</li>
                        <li>📈 A bigger pool attracts more pilots → more burns → more XEN destroyed forever</li>
                        <li>🔒 You can't donate to the wrong address — the program enforces it</li>
                        <li>🌍 You become part of the deflationary engine — permanently, on-chain</li>
                    </ul>
                </div>

                {/* Comparison table */}
                <div className="mb-6">
                    <h4 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">How Donations Compare to Other Sources</h4>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left border-b border-gray-700">
                                    <th className="pb-2 pr-4 text-gray-400">Source</th>
                                    <th className="pb-2 pr-4 text-green-400">Pool Gets</th>
                                    <th className="pb-2 text-gray-400">Remainder</th>
                                </tr>
                            </thead>
                            <tbody className="text-gray-300">
                                <tr className="border-b border-gray-800/50">
                                    <td className="py-2 pr-4 text-green-400 font-bold">💚 Your donation</td>
                                    <td className="py-2 pr-4 font-bold text-green-400">100%</td>
                                    <td className="py-2 text-gray-500">—</td>
                                </tr>
                                <tr className="border-b border-gray-800/50">
                                    <td className="py-2 pr-4">Early-exit penalty</td>
                                    <td className="py-2 pr-4 text-green-400">93.5%</td>
                                    <td className="py-2 text-gray-400">6.5% (oracle / ref / dev / escrow)</td>
                                </tr>
                                <tr className="border-b border-gray-800/50">
                                    <td className="py-2 pr-4">NFT sale (Phase 2)</td>
                                    <td className="py-2 pr-4 text-green-400">95.5%</td>
                                    <td className="py-2 text-gray-400">4.5% (oracle / ref / architect)</td>
                                </tr>
                                <tr>
                                    <td className="py-2 pr-4">Game fees (losses)</td>
                                    <td className="py-2 pr-4 text-green-400">100%</td>
                                    <td className="py-2 text-gray-400">—</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Donation input */}
                {x1Connected ? (
                    <div className="space-y-3">
                        <div className="flex gap-2">
                            <input
                                type="number"
                                value={amount}
                                onChange={e => setAmount(e.target.value)}
                                placeholder="Amount in XNT"
                                min="0"
                                step="0.1"
                                className="flex-1 bg-black/50 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:border-green-500 focus:outline-none"
                            />
                            <button
                                onClick={handleDonate}
                                disabled={status === 'pending' || !amount || parseFloat(amount) <= 0}
                                className="px-6 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold rounded-lg transition-colors flex items-center gap-2"
                            >
                                {status === 'pending' ? (
                                    <><Loader className="w-4 h-4 animate-spin" /> Donating...</>
                                ) : (
                                    <><Heart className="w-4 h-4" /> Donate to Pool</>
                                )}
                            </button>
                        </div>

                        {status === 'success' && txHash && (
                            <div className="flex items-center gap-2 text-green-400 text-sm">
                                <CheckCircle className="w-4 h-4" />
                                <span>Donation confirmed! </span>
                                <a
                                    href={`https://explorer.mainnet.x1.xyz/tx/${txHash}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-1 underline"
                                >
                                    View on X1 Explorer <ExternalLink className="w-3 h-3" />
                                </a>
                            </div>
                        )}

                        {status === 'error' && errorMsg && (
                            <div className="flex items-start gap-2 text-red-400 text-sm">
                                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                                <span>{errorMsg}</span>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="bg-black/30 border border-gray-700 rounded-lg p-4 text-center">
                        <p className="text-gray-400 text-sm">Connect your X1 Wallet to donate XNT directly to the reward pool.</p>
                    </div>
                )}

                <div className="mt-4 pt-4 border-t border-gray-800">
                    <p className="text-xs text-gray-500">
                        Every pool donation emits a <code>Donated(donor, amount)</code> event visible on the X1 explorer.
                        Anyone can verify 100% reached the pool by inspecting the vault PDA balance before and after.
                    </p>
                </div>
            </div>


        </div>
    );
}
