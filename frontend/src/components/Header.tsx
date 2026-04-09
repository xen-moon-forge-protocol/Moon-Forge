/**
 * Moon Forge - Header Component v9.0
 * 
 * Navigation and dual wallet connection.
 * Clear distinction between EVM (XEN) and X1 (XNT) wallets.
 */

import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, X, Wallet, Moon, Zap } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import { shortenAddress } from '../lib/constants';

const NAV_ITEMS = [
    { path: '/', label: 'Home' },
    { path: '/forge', label: 'The Forge', icon: '🔥' },
    { path: '/missions', label: 'Missions', icon: '🚀' },
    { path: '/nft', label: 'Artifacts', icon: '🎯' },
    { path: '/marketplace', label: 'Marketplace', icon: '🛒' },
    { path: '/donate', label: 'Donate', icon: '💚' },
    { path: '/games', label: 'Games', icon: '🎮' },
    { path: '/whitepaper', label: 'Whitepaper', icon: '📖' },
    { path: '/transparency', label: 'Transparency', icon: '🔍' },
];

export default function Header() {
    const [mobileOpen, setMobileOpen] = useState(false);
    const location = useLocation();
    const { evmAddress, x1Address, x1Connected, isConnecting, connectEVM, disconnectEVM, setX1Address } = useWallet();

    // Determine which wallet is primarily needed based on current page
    const isEVMPage = ['/forge', '/'].includes(location.pathname);
    const isX1Page = ['/missions', '/nft'].includes(location.pathname);

    const handleX1Input = () => {
        const address = prompt('Enter your X1 wallet address (Base58 Solana format — copy from X1 Wallet or Backpack):');
        // Solana/SVM public keys: Base58 encoded, 32-44 chars, no 0x prefix
        if (address && address.length >= 32 && address.length <= 44 && !address.startsWith('0x')) {
            setX1Address(address);
        } else if (address) {
            alert('Invalid X1 address. Please enter your Solana-format public key from the X1 Wallet extension (not an 0x EVM address).');
        }
    };

    return (
        <header className="sticky top-0 z-50 glass border-b border-white/5">
            <div className="container mx-auto px-4">
                <div className="flex items-center justify-between h-16">
                    {/* Logo */}
                    <Link to="/" className="flex items-center gap-2">
                        <Moon className="w-8 h-8 text-forge-gold" />
                        <span className="font-space text-xl font-bold bg-gradient-to-r from-forge-orange to-forge-gold bg-clip-text text-transparent">
                            MOON FORGE
                        </span>
                    </Link>

                    {/* Desktop Nav */}
                    <nav className="hidden md:flex items-center gap-6">
                        {NAV_ITEMS.map(item => (
                            <Link
                                key={item.path}
                                to={item.path}
                                className={`flex items-center gap-1 text-sm transition-colors ${location.pathname === item.path
                                    ? 'text-forge-orange'
                                    : 'text-lunar-300 hover:text-white'
                                    }`}
                            >
                                {item.icon && <span>{item.icon}</span>}
                                {item.label}
                            </Link>
                        ))}
                    </nav>

                    {/* Wallet Connection - DUAL WALLETS */}
                    <div className="hidden md:flex items-center gap-2">
                        {/* X1 Wallet (for XNT - Missions/Artifacts) */}
                        {x1Address ? (
                            <div className="px-3 py-1.5 bg-mission-moon/20 border border-mission-moon/30 rounded-lg text-sm flex items-center gap-2">
                                <Zap className="w-3 h-3 text-mission-moon" />
                                <span className="text-lunar-400 text-xs">X1:</span>
                                <span className="text-mission-moon">{shortenAddress(x1Address)}</span>
                            </div>
                        ) : isX1Page && (
                            <button
                                onClick={handleX1Input}
                                className="px-3 py-1.5 bg-mission-moon/20 border border-mission-moon/30 rounded-lg text-sm text-mission-moon hover:bg-mission-moon/30 transition-colors flex items-center gap-2"
                            >
                                <Zap className="w-3 h-3" />
                                Add X1 Wallet
                            </button>
                        )}

                        {/* EVM Wallet (for XEN - Burning) */}
                        {evmAddress ? (
                            <button
                                onClick={disconnectEVM}
                                className="flex items-center gap-2 px-4 py-2 bg-space-700 hover:bg-space-600 rounded-lg transition-colors"
                            >
                                <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                                <span className="text-xs text-lunar-400">EVM:</span>
                                <span className="text-sm">{shortenAddress(evmAddress)}</span>
                            </button>
                        ) : (
                            <button
                                onClick={connectEVM}
                                disabled={isConnecting}
                                className="btn-forge text-sm flex items-center gap-2"
                            >
                                <Wallet className="w-4 h-4" />
                                {isConnecting ? 'Connecting...' : (
                                    isEVMPage ? 'Connect EVM Wallet' : 'Connect Wallet'
                                )}
                            </button>
                        )}
                    </div>

                    {/* Mobile Menu Button */}
                    <button
                        onClick={() => setMobileOpen(!mobileOpen)}
                        className="md:hidden p-2"
                    >
                        {mobileOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
                    </button>
                </div>

                {/* Mobile Menu */}
                {mobileOpen && (
                    <div className="md:hidden py-4 border-t border-white/5">
                        <nav className="flex flex-col gap-4">
                            {NAV_ITEMS.map(item => (
                                <Link
                                    key={item.path}
                                    to={item.path}
                                    onClick={() => setMobileOpen(false)}
                                    className={`flex items-center gap-2 text-lg ${location.pathname === item.path
                                        ? 'text-forge-orange'
                                        : 'text-lunar-300'
                                        }`}
                                >
                                    {item.icon && <span>{item.icon}</span>}
                                    {item.label}
                                </Link>
                            ))}

                            <hr className="border-white/10" />

                            {/* Wallet Status */}
                            <div className="space-y-2">
                                <p className="text-xs text-lunar-400">Wallets:</p>

                                {/* EVM */}
                                <div className="flex items-center justify-between">
                                    <span className="text-sm text-lunar-400">EVM (XEN):</span>
                                    {evmAddress ? (
                                        <span className="text-sm text-green-400">{shortenAddress(evmAddress)}</span>
                                    ) : (
                                        <span className="text-sm text-red-400">Not connected</span>
                                    )}
                                </div>

                                {/* X1 */}
                                <div className="flex items-center justify-between">
                                    <span className="text-sm text-lunar-400">X1 (XNT):</span>
                                    {x1Address ? (
                                        <span className="text-sm text-mission-moon">{shortenAddress(x1Address)}</span>
                                    ) : (
                                        <span className="text-sm text-red-400">Not set</span>
                                    )}
                                </div>
                            </div>

                            <hr className="border-white/10" />

                            {evmAddress ? (
                                <button
                                    onClick={() => { disconnectEVM(); setMobileOpen(false); }}
                                    className="text-left text-red-400"
                                >
                                    Disconnect EVM
                                </button>
                            ) : (
                                <button
                                    onClick={() => { connectEVM(); setMobileOpen(false); }}
                                    className="btn-forge text-center"
                                >
                                    Connect EVM Wallet
                                </button>
                            )}

                            {!x1Address && (
                                <button
                                    onClick={() => { handleX1Input(); setMobileOpen(false); }}
                                    className="btn-outline text-center text-mission-moon border-mission-moon/30"
                                >
                                    Add X1 Wallet
                                </button>
                            )}
                        </nav>
                    </div>
                )}
            </div>
        </header>
    );
}
