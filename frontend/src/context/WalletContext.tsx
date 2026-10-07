/**
 * Moon Forge - Wallet Context
 *
 * DUAL wallet:
 *  1. EVM wallet (MetaMask or any injected EIP-1193 wallet) — burns XEN through MoonForgePortal v2.
 *  2. X1 wallet (SVM) — signs every X1 action (claims, games, Artifacts, donations).
 *     Detection order: window.x1 → window.x1Wallet → window.backpack.solana.
 *     The raw provider is exposed as `x1Provider` and is directly usable by lib/protocol.ts.
 *
 * X1 runs the Solana VM: addresses are Base58 public keys, never 0x.
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { ethers } from 'ethers';
import { CHAINS, PROJECT_LINKS } from '../lib/constants';
import { X1_RPC, X1Provider } from '../lib/protocol';

interface WalletState {
    evmAddress: string | null;
    evmChainId: number | null;
    evmProvider: ethers.BrowserProvider | null;
    evmSigner: ethers.Signer | null;

    x1Address: string | null;
    x1Connected: boolean;
    x1Connection: Connection | null;
    x1Provider: X1Provider | null;
    x1WalletType: 'x1wallet' | 'backpack' | null;

    isConnecting: boolean;
    error: string | null;
}

interface WalletContextType extends WalletState {
    connectEVM: () => Promise<void>;
    disconnectEVM: () => void;
    /** Switches MetaMask to `chainId` (adds the chain if missing). Throws if the user refuses. */
    switchChain: (chainId: number) => Promise<void>;
    connectX1: () => Promise<void>;
    disconnectX1: () => void;
    clearError: () => void;
}

const WalletContext = createContext<WalletContextType | null>(null);

export const useWallet = () => {
    const ctx = useContext(WalletContext);
    if (!ctx) throw new Error('useWallet must be inside WalletProvider');
    return ctx;
};

function detectX1(): { provider: any; type: 'x1wallet' | 'backpack' } | null {
    const w = window as any;
    if (w.x1) return { provider: w.x1, type: 'x1wallet' };
    if (w.x1Wallet) return { provider: w.x1Wallet, type: 'x1wallet' };
    if (w.backpack?.solana) return { provider: w.backpack.solana, type: 'backpack' };
    return null;
}

/** Wraps the injected object so it always satisfies protocol.ts `X1Provider`. */
function asX1Provider(raw: any, publicKey: PublicKey): X1Provider {
    return {
        publicKey,
        signTransaction: (tx) => raw.signTransaction(tx),
        signAllTransactions: raw.signAllTransactions ? (txs) => raw.signAllTransactions(txs) : undefined,
    };
}

export const WalletProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [state, setState] = useState<WalletState>({
        evmAddress: null,
        evmChainId: null,
        evmProvider: null,
        evmSigner: null,
        x1Address: null,
        x1Connected: false,
        x1Connection: null,
        x1Provider: null,
        x1WalletType: null,
        isConnecting: false,
        error: null,
    });
    const rawX1 = useRef<any>(null);

    // ─── EVM ─────────────────────────────────────────────────────────────────

    /** Re-creates provider + signer: ethers v6 BrowserProvider is bound to one network/account. */
    const rebuildEvm = useCallback(async () => {
        if (!window.ethereum) return;
        try {
            const provider = new ethers.BrowserProvider(window.ethereum);
            const accounts: string[] = await provider.send('eth_accounts', []);
            if (!accounts || accounts.length === 0) {
                setState(prev => ({ ...prev, evmAddress: null, evmSigner: null, evmProvider: null, evmChainId: null }));
                return;
            }
            const network = await provider.getNetwork();
            const signer = await provider.getSigner();
            setState(prev => ({
                ...prev,
                evmAddress: accounts[0],
                evmChainId: Number(network.chainId),
                evmProvider: provider,
                evmSigner: signer,
            }));
        } catch {
            /* keep previous state */
        }
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined' || !window.ethereum) return;
        const onChange = () => { void rebuildEvm(); };
        window.ethereum.on?.('accountsChanged', onChange);
        window.ethereum.on?.('chainChanged', onChange);
        return () => {
            window.ethereum?.removeListener?.('accountsChanged', onChange);
            window.ethereum?.removeListener?.('chainChanged', onChange);
        };
    }, [rebuildEvm]);

    const connectEVM = useCallback(async () => {
        if (typeof window === 'undefined' || !window.ethereum) {
            setState(prev => ({ ...prev, error: 'No EVM wallet detected. Install MetaMask (or another injected wallet) to burn XEN.' }));
            return;
        }
        setState(prev => ({ ...prev, isConnecting: true, error: null }));
        try {
            const provider = new ethers.BrowserProvider(window.ethereum);
            const accounts = await provider.send('eth_requestAccounts', []);
            if (!accounts || accounts.length === 0) throw new Error('No accounts found. Unlock your wallet and try again.');
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
            let errorMessage = 'Failed to connect the EVM wallet';
            if (err.code === 4001) errorMessage = 'Connection rejected in the wallet.';
            else if (err.code === -32002) errorMessage = 'A connection request is already pending. Check your wallet.';
            else if (err.message) errorMessage = err.message;
            setState(prev => ({ ...prev, error: errorMessage, isConnecting: false }));
        }
    }, []);

    const disconnectEVM = useCallback(() => {
        setState(prev => ({ ...prev, evmAddress: null, evmChainId: null, evmProvider: null, evmSigner: null }));
    }, []);

    const switchChain = useCallback(async (chainId: number) => {
        if (!window.ethereum) throw new Error('No EVM wallet detected');
        const hex = `0x${chainId.toString(16)}`;
        try {
            await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
        } catch (err: any) {
            if (err.code !== 4902) throw err;
            const c = Object.values(CHAINS).find(x => x.chainId === chainId);
            if (!c) throw new Error(`Unknown chain ${chainId}`);
            await window.ethereum.request({
                method: 'wallet_addEthereumChain',
                params: [{
                    chainId: hex,
                    chainName: c.name,
                    rpcUrls: [c.rpcUrl],
                    blockExplorerUrls: [c.explorer],
                    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: 18 },
                }],
            });
        }
        await rebuildEvm();
    }, [rebuildEvm]);

    // ─── X1 (SVM) ────────────────────────────────────────────────────────────

    const applyX1 = useCallback((raw: any, type: 'x1wallet' | 'backpack', pkLike: any) => {
        const publicKey = new PublicKey(pkLike.toString());
        rawX1.current = raw;
        setState(prev => ({
            ...prev,
            x1Address: publicKey.toBase58(),
            x1Connected: true,
            x1Connection: new Connection(X1_RPC, 'confirmed'),
            x1Provider: asX1Provider(raw, publicKey),
            x1WalletType: type,
            isConnecting: false,
            error: type === 'backpack'
                ? 'Note: connected via Backpack. Make sure the X1 RPC (rpc.mainnet.x1.xyz) is selected in Backpack.'
                : null,
        }));
    }, []);

    const disconnectX1 = useCallback(() => {
        try { rawX1.current?.disconnect?.(); } catch { /* ignore */ }
        rawX1.current = null;
        setState(prev => ({
            ...prev,
            x1Address: null,
            x1Connected: false,
            x1Connection: null,
            x1Provider: null,
            x1WalletType: null,
        }));
    }, []);

    const connectX1 = useCallback(async () => {
        const found = detectX1();
        if (!found) {
            setState(prev => ({
                ...prev,
                error: `No X1 wallet detected. Install the X1 Wallet (${PROJECT_LINKS.x1Wallet}) or Backpack, then reload.`,
            }));
            return;
        }
        setState(prev => ({ ...prev, isConnecting: true, error: null }));
        try {
            const resp = await found.provider.connect();
            const pk = found.provider.publicKey ?? resp?.publicKey;
            if (!pk) throw new Error('The wallet did not return a public key');
            applyX1(found.provider, found.type, pk);
        } catch (err: any) {
            setState(prev => ({ ...prev, error: `X1 connection failed: ${err?.message || err}`, isConnecting: false }));
        }
    }, [applyX1]);

    // Silent reconnect if the site is already trusted, and follow account switches.
    useEffect(() => {
        const found = detectX1();
        if (!found) return;
        const p = found.provider;
        (async () => {
            try {
                if (p.isConnected && p.publicKey) { applyX1(p, found.type, p.publicKey); return; }
                const resp = await p.connect?.({ onlyIfTrusted: true });
                const pk = p.publicKey ?? resp?.publicKey;
                if (pk) applyX1(p, found.type, pk);
            } catch { /* not trusted yet: user must click Connect */ }
        })();
        const onAccount = (pk: any) => {
            if (pk) applyX1(p, found.type, pk);
            else disconnectX1();
        };
        const onDisconnect = () => disconnectX1();
        p.on?.('accountChanged', onAccount);
        p.on?.('disconnect', onDisconnect);
        return () => {
            p.off?.('accountChanged', onAccount);
            p.off?.('disconnect', onDisconnect);
            p.removeListener?.('accountChanged', onAccount);
            p.removeListener?.('disconnect', onDisconnect);
        };
    }, [applyX1, disconnectX1]);

    const clearError = useCallback(() => setState(prev => ({ ...prev, error: null })), []);

    return (
        <WalletContext.Provider
            value={{
                ...state,
                connectEVM,
                disconnectEVM,
                switchChain,
                connectX1,
                disconnectX1,
                clearError,
            }}
        >
            {children}
        </WalletContext.Provider>
    );
};

declare global {
    interface Window {
        ethereum?: any;
        backpack?: { solana?: any };
        solana?: any;
        x1?: any;
        x1Wallet?: any;
    }
}
