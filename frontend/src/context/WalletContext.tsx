/**
 * Moon Forge - Wallet Context
 *
 * Manages DUAL wallet connections:
 *
 * 1. EVM Wallet (MetaMask) — for burning XEN on Ethereum, Optimism, BSC, Polygon, Avalanche
 *    - Signs transactions on EVM chains calling MoonForgePortal.sol
 *    - User provides their X1 (Backpack) address as the reward destination
 *
 * 2. X1 SVM Wallet (X1 Wallet / Backpack) — for claiming XNT on X1 Blockchain
 *    - X1 runs the Solana Virtual Machine (SVM), NOT EVM
 *    - Users interact with the MoonForge Anchor program on X1 to claim XNT
 *    - x1Address = Base58 Solana public key (e.g. "7xLk17EQQ5KLDLDe44wCmupJKJjTGd8hs3eSVVhCx19")
 *    - Recommended wallet: Backpack (backpack.app) — natively supports X1
 *
 * FLOW:
 *   MetaMask → burn XEN on EVM chain → Portal emits MissionStarted(x1TargetAddress)
 *   Oracle reads event → publishes Merkle root to X1 SVM Anchor program
 *   Backpack → call claim instruction on X1 Anchor program → receive XNT
 */

import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { Connection } from '@solana/web3.js';
import { ethers } from 'ethers';
import { CHAINS } from '../lib/constants';

// ═══════════════════════════════════════════════════════════════════════════
//                              TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface WalletState {
    // EVM Wallet (MetaMask) — for XEN burns on Ethereum, Optimism, BSC, Polygon, Avalanche
    evmAddress: string | null;
    evmChainId: number | null;
    evmProvider: ethers.BrowserProvider | null;
    evmSigner: ethers.Signer | null;

    // X1 SVM Wallet (X1 Wallet official / Backpack) — for XNT claims on X1 Blockchain
    // x1Address = Base58 Solana public key (NOT a 0x EVM address)
    x1Address: string | null;
    x1Connected: boolean;
    x1Connection: Connection | null; // @solana/web3.js Connection to X1 SVM RPC
    x1WalletType: 'x1wallet' | 'backpack' | null; // which wallet is connected

    // Status
    isConnecting: boolean;
    error: string | null;
}

interface WalletContextType extends WalletState {
    connectEVM: () => Promise<void>;
    disconnectEVM: () => void;
    switchChain: (chainId: number) => Promise<void>;
    setX1Address: (address: string) => void;
    connectX1: () => Promise<void>; // connects X1 Wallet or Backpack to X1 SVM
    disconnectX1: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════
//                              CONTEXT
// ═══════════════════════════════════════════════════════════════════════════

const WalletContext = createContext<WalletContextType | null>(null);

export const useWallet = () => {
    const ctx = useContext(WalletContext);
    if (!ctx) throw new Error('useWallet must be inside WalletProvider');
    return ctx;
};

// ═══════════════════════════════════════════════════════════════════════════
//                              PROVIDER
// ═══════════════════════════════════════════════════════════════════════════

export const WalletProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [state, setState] = useState<WalletState>({
        evmAddress: null,
        evmChainId: null,
        evmProvider: null,
        evmSigner: null,
        x1Address: null,
        x1Connected: false,
        x1Connection: null,
        x1WalletType: null,
        isConnecting: false,
        error: null,
    });

    // Check for saved X1 address (persisted across sessions)
    useEffect(() => {
        const savedX1 = localStorage.getItem('moonforge_x1_address');
        if (savedX1) {
            setState(prev => ({ ...prev, x1Address: savedX1 }));
        }
    }, []);

    // Listen for EVM account/chain changes
    useEffect(() => {
        if (typeof window === 'undefined' || !window.ethereum) return;

        const handleAccountsChanged = (accounts: string[]) => {
            if (accounts.length === 0) {
                setState(prev => ({
                    ...prev,
                    evmAddress: null,
                    evmSigner: null,
                }));
            } else {
                setState(prev => ({ ...prev, evmAddress: accounts[0] }));
            }
        };

        const handleChainChanged = (chainId: string) => {
            setState(prev => ({ ...prev, evmChainId: parseInt(chainId, 16) }));
        };

        window.ethereum.on('accountsChanged', handleAccountsChanged);
        window.ethereum.on('chainChanged', handleChainChanged);

        return () => {
            window.ethereum?.removeListener('accountsChanged', handleAccountsChanged);
            window.ethereum?.removeListener('chainChanged', handleChainChanged);
        };
    }, []);

    // ─────────────────────────────────────────────────────────────────────────
    //                         EVM CONNECTION (MetaMask)
    //                 Used for XEN burns on EVM chains only
    // ─────────────────────────────────────────────────────────────────────────

    const connectEVM = useCallback(async () => {
        if (typeof window === 'undefined' || !window.ethereum) {
            setState(prev => ({
                ...prev,
                error: '🦊 MetaMask not detected. Install MetaMask to burn XEN on EVM chains.',
            }));
            window.open('https://metamask.io/download/', '_blank');
            return;
        }

        setState(prev => ({ ...prev, isConnecting: true, error: null }));

        try {
            const provider = new ethers.BrowserProvider(window.ethereum);
            const accounts = await provider.send('eth_requestAccounts', []);

            if (!accounts || accounts.length === 0) {
                throw new Error('No accounts found. Please unlock MetaMask and try again.');
            }

            const signer = await provider.getSigner();
            const network = await provider.getNetwork();

            setState(prev => ({
                ...prev,
                evmAddress: accounts[0],
                evmChainId: Number(network.chainId),
                evmProvider: provider,
                evmSigner: signer,
                isConnecting: false,
                error: null,
            }));
        } catch (err: any) {
            let errorMessage = 'Failed to connect wallet';

            if (err.code === 4001) {
                errorMessage = '❌ Connection rejected. Please approve in MetaMask.';
            } else if (err.code === -32002) {
                errorMessage = '⏳ Connection pending. Check MetaMask for a pending request.';
            } else if (err.code === -32603) {
                errorMessage = '🔒 MetaMask is locked. Please unlock it and try again.';
            } else if (err.message?.includes('Already processing')) {
                errorMessage = '⏳ Already processing. Please check MetaMask.';
            } else if (err.message) {
                errorMessage = `⚠️ ${err.message}`;
            }

            setState(prev => ({
                ...prev,
                error: errorMessage,
                isConnecting: false,
            }));
        }
    }, []);

    const disconnectEVM = useCallback(() => {
        setState(prev => ({
            ...prev,
            evmAddress: null,
            evmChainId: null,
            evmProvider: null,
            evmSigner: null,
        }));
    }, []);

    const switchChain = useCallback(async (chainId: number) => {
        // X1 is SVM — never attempt to switch to it via MetaMask (chainId 0 = not an EVM chain).
        // X1 connection is handled separately via connectX1() using @solana/web3.js.
        if (!window.ethereum || chainId === 0) return;

        try {
            await window.ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: `0x${chainId.toString(16)}` }],
            });
        } catch (err: any) {
            if (err.code === 4902) {
                // Only add EVM chains (chainId > 0); x1 is excluded by the guard above
                const chainConfig = Object.values(CHAINS).find(c => c.chainId === chainId && c.chainId > 0);
                if (chainConfig) {
                    await window.ethereum.request({
                        method: 'wallet_addEthereumChain',
                        params: [{
                            chainId: `0x${chainId.toString(16)}`,
                            chainName: chainConfig.name,
                            rpcUrls: [chainConfig.rpcUrl],
                        }],
                    });
                }
            }
        }
    }, []);

    // ─────────────────────────────────────────────────────────────────────────
    //                  X1 SVM CONNECTION (X1 Wallet official / Backpack)
    //
    // X1 runs the Solana Virtual Machine (SVM) — NOT EVM.
    // Compatible wallets: X1 Wallet (official, window.x1) and Backpack (window.backpack.solana).
    // Phantom (window.solana) is NOT compatible with X1 mainnet — do NOT add it as fallback.
    // x1Address = Base58 Solana public key — completely different from 0x EVM addresses.
    // Users call the MoonForge Anchor program on X1 to claim XNT rewards.
    //
    // Install X1 Wallet: https://chromewebstore.google.com/detail/x1-wallet/kcfmcpdmlchhbikbogddmgopmjbflnae
    // ─────────────────────────────────────────────────────────────────────────

    const X1_WALLET_URL = 'https://chromewebstore.google.com/detail/x1-wallet/kcfmcpdmlchhbikbogddmgopmjbflnae';

    const setX1Address = useCallback((address: string) => {
        localStorage.setItem('moonforge_x1_address', address);
        setState(prev => ({ ...prev, x1Address: address }));
    }, []);

    const connectX1 = useCallback(async () => {
        // Supported wallets: X1 Wallet (official, window.x1) → Backpack (window.backpack.solana)
        // - X1 Wallet: X1 network is pre-configured, connect directly.
        // - Backpack: user must manually add X1 RPC (rpc.mainnet.x1.xyz) in Settings → Solana → Custom RPC.
        // Phantom (window.solana) is NOT compatible with X1 mainnet — intentionally excluded.
        const isX1Wallet = !!(window as any).x1;
        const isBackpack = !isX1Wallet && !!(window as any).backpack?.solana;
        const provider = isX1Wallet
            ? (window as any).x1
            : isBackpack
                ? (window as any).backpack.solana
                : null;

        if (!provider) {
            setState(prev => ({
                ...prev,
                error: 'No compatible X1 wallet detected. Install the official X1 Wallet (recommended) or Backpack.',
            }));
            window.open(X1_WALLET_URL, '_blank');
            return;
        }

        setState(prev => ({ ...prev, isConnecting: true, error: null }));

        try {
            const resp = await provider.connect();
            const address = resp.publicKey.toString(); // Base58 Solana public key

            // Create @solana/web3.js Connection to X1 SVM RPC
            const connection = new Connection(CHAINS.x1.rpcUrl, 'confirmed');

            const walletType = isX1Wallet ? 'x1wallet' : 'backpack';

            setX1Address(address);
            setState(prev => ({
                ...prev,
                x1Address: address,
                x1Connected: true,
                x1Connection: connection,
                x1WalletType: walletType,
                isConnecting: false,
                // Remind Backpack users to configure the X1 RPC if they haven't already
                error: walletType === 'backpack'
                    ? 'Connected via Backpack. Make sure X1 RPC (rpc.mainnet.x1.xyz) is set in Backpack → Settings → Solana → Custom RPC.'
                    : null,
            }));
        } catch (err: any) {
            setState(prev => ({
                ...prev,
                error: `X1 connection failed: ${err.message}`,
                isConnecting: false,
            }));
        }
    }, [setX1Address]);

    const disconnectX1 = useCallback(() => {
        localStorage.removeItem('moonforge_x1_address');
        setState(prev => ({
            ...prev,
            x1Address: null,
            x1Connected: false,
            x1Connection: null,
            x1WalletType: null,
        }));
    }, []);

    // ─────────────────────────────────────────────────────────────────────────

    return (
        <WalletContext.Provider
            value={{
                ...state,
                connectEVM,
                disconnectEVM,
                switchChain,
                setX1Address,
                connectX1,
                disconnectX1,
            }}
        >
            {children}
        </WalletContext.Provider>
    );
};

// Type augmentation
declare global {
    interface Window {
        ethereum?: any;
        backpack?: { solana?: any };
        solana?: any;
    }
}
