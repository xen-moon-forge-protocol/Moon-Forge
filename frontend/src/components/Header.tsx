/**
 * Moon Forge - Header
 * Navigation + dual wallet: EVM (burn XEN) and X1 (everything on X1).
 */

import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, X, Wallet, Moon, Zap, LogOut } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import { shortenAddress } from '../lib/constants';

const NAV_ITEMS = [
    { path: '/', label: 'Home' },
    { path: '/forge', label: 'The Forge', icon: '🔥' },
    { path: '/missions', label: 'Missions', icon: '🚀' },
    { path: '/artifacts', label: 'Artifacts', icon: '💎' },
    { path: '/games', label: 'Games', icon: '🎮' },
    { path: '/donate', label: 'Donate', icon: '💚' },
    { path: '/transparency', label: 'Transparency', icon: '🔍' },
    { path: '/whitepaper', label: 'Whitepaper', icon: '📖' },
];

export default function Header() {
    const [mobileOpen, setMobileOpen] = useState(false);
    const location = useLocation();
    const {
        evmAddress, x1Address, x1Connected, isConnecting, error, clearError,
        connectEVM, disconnectEVM, connectX1, disconnectX1,
    } = useWallet();

    return (
        <header className="sticky top-0 z-50 glass border-b border-white/5">
            <div className="container mx-auto px-4">
                <div className="flex items-center justify-between h-16 gap-4">
                    <Link to="/" className="flex items-center gap-2 flex-shrink-0">
                        <Moon className="w-8 h-8 text-forge-gold" />
                        <span className="font-space text-xl font-bold bg-gradient-to-r from-forge-orange to-forge-gold bg-clip-text text-transparent">
                            MOON FORGE
                        </span>
                    </Link>

                    <nav className="hidden xl:flex items-center gap-5">
                        {NAV_ITEMS.map(item => (
                            <Link
                                key={item.path}
                                to={item.path}
                                className={`flex items-center gap-1 text-sm transition-colors ${location.pathname === item.path ? 'text-forge-orange' : 'text-lunar-300 hover:text-white'}`}
                            >
                                {item.icon && <span>{item.icon}</span>}
                                {item.label}
                            </Link>
                        ))}
                    </nav>

                    <div className="hidden md:flex items-center gap-2">
                        {x1Connected && x1Address ? (
                            <button
                                onClick={disconnectX1}
                                title="Disconnect X1 wallet"
                                className="px-3 py-1.5 bg-mission-moon/20 border border-mission-moon/30 rounded-lg text-sm flex items-center gap-2 hover:bg-mission-moon/30"
                            >
                                <Zap className="w-3 h-3 text-mission-moon" />
                                <span className="text-lunar-400 text-xs">X1:</span>
                                <span className="text-mission-moon">{shortenAddress(x1Address)}</span>
                                <LogOut className="w-3 h-3 text-lunar-400" />
                            </button>
                        ) : (
                            <button
                                onClick={connectX1}
                                disabled={isConnecting}
                                className="px-3 py-1.5 bg-mission-moon/20 border border-mission-moon/30 rounded-lg text-sm text-mission-moon hover:bg-mission-moon/30 transition-colors flex items-center gap-2"
                            >
                                <Zap className="w-3 h-3" /> Connect X1
                            </button>
                        )}

                        {evmAddress ? (
                            <button
                                onClick={disconnectEVM}
                                title="Disconnect EVM wallet"
                                className="flex items-center gap-2 px-3 py-1.5 bg-space-700 hover:bg-space-600 rounded-lg transition-colors"
                            >
                                <div className="w-2 h-2 rounded-full bg-green-400" />
                                <span className="text-xs text-lunar-400">EVM:</span>
                                <span className="text-sm">{shortenAddress(evmAddress)}</span>
                            </button>
                        ) : (
                            <button onClick={connectEVM} disabled={isConnecting} className="btn-forge text-sm !px-4 !py-2 flex items-center gap-2">
                                <Wallet className="w-4 h-4" /> Connect EVM
                            </button>
                        )}
                    </div>

                    <button onClick={() => setMobileOpen(!mobileOpen)} className="xl:hidden p-2" aria-label="Menu">
                        {mobileOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
                    </button>
                </div>

                {error && (
                    <div className="pb-2 flex items-start justify-between gap-3 text-xs text-amber-300">
                        <span className="break-words">{error}</span>
                        <button onClick={clearError} className="text-lunar-400 hover:text-white flex-shrink-0">dismiss</button>
                    </div>
                )}

                {mobileOpen && (
                    <div className="xl:hidden py-4 border-t border-white/5">
                        <nav className="flex flex-col gap-4">
                            {NAV_ITEMS.map(item => (
                                <Link
                                    key={item.path}
                                    to={item.path}
                                    onClick={() => setMobileOpen(false)}
                                    className={`flex items-center gap-2 text-lg ${location.pathname === item.path ? 'text-forge-orange' : 'text-lunar-300'}`}
                                >
                                    {item.icon && <span>{item.icon}</span>}
                                    {item.label}
                                </Link>
                            ))}
                            <hr className="border-white/10 md:hidden" />
                            <div className="flex flex-col gap-2 md:hidden">
                                {x1Connected && x1Address ? (
                                    <button onClick={() => { disconnectX1(); setMobileOpen(false); }} className="text-left text-sm text-mission-moon">
                                        X1: {shortenAddress(x1Address)} (disconnect)
                                    </button>
                                ) : (
                                    <button onClick={() => { connectX1(); setMobileOpen(false); }} className="btn-outline text-center">Connect X1 Wallet</button>
                                )}
                                {evmAddress ? (
                                    <button onClick={() => { disconnectEVM(); setMobileOpen(false); }} className="text-left text-sm text-green-400">
                                        EVM: {shortenAddress(evmAddress)} (disconnect)
                                    </button>
                                ) : (
                                    <button onClick={() => { connectEVM(); setMobileOpen(false); }} className="btn-forge text-center">Connect EVM Wallet</button>
                                )}
                            </div>
                        </nav>
                    </div>
                )}
            </div>
        </header>
    );
}
