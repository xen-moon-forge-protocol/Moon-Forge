/**
 * Small shared UI pieces. Every number they render comes from the caller (on-chain reads);
 * missing data renders as "--".
 */
import { ReactNode } from 'react';
import { ExternalLink, AlertTriangle, Info, CheckCircle, XCircle, Loader2, Zap } from 'lucide-react';
import { explorerAddress, explorerTx } from '../lib/protocol';
import { formatXNT, shortenAddress } from '../lib/constants';
import { useWallet } from '../context/WalletContext';

export function Xnt({ lamports, digits = 4, className = '' }: { lamports: number | bigint | null | undefined; digits?: number; className?: string }) {
    return <span className={className}>{formatXNT(lamports, digits)} XNT</span>;
}

export function TxLink({ sig, label }: { sig: string | null | undefined; label?: string }) {
    if (!sig) return <span className="text-lunar-500">--</span>;
    return (
        <a href={explorerTx(sig)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-forge-orange hover:underline font-mono text-xs break-all">
            {label ?? shortenAddress(sig, 8, 8)} <ExternalLink className="w-3 h-3 flex-shrink-0" />
        </a>
    );
}

export function AddrLink({ address, full = false }: { address: string | { toString(): string } | null | undefined; full?: boolean }) {
    if (!address) return <span className="text-lunar-500">--</span>;
    const a = address.toString();
    return (
        <a href={explorerAddress(a)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-forge-orange hover:underline font-mono text-xs break-all">
            {full ? a : shortenAddress(a, 6, 6)} <ExternalLink className="w-3 h-3 flex-shrink-0" />
        </a>
    );
}

export function EvmTxLink({ explorer, hash }: { explorer: string; hash: string | null | undefined }) {
    if (!hash) return <span className="text-lunar-500">--</span>;
    return (
        <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-forge-orange hover:underline font-mono text-xs break-all">
            {shortenAddress(hash, 10, 8)} <ExternalLink className="w-3 h-3 flex-shrink-0" />
        </a>
    );
}

const NOTICE_STYLE = {
    info: { box: 'bg-mission-launchpad/10 border-mission-launchpad/30 text-lunar-200', icon: <Info className="w-4 h-4 text-mission-launchpad flex-shrink-0 mt-0.5" /> },
    warn: { box: 'bg-amber-500/10 border-amber-500/30 text-amber-200', icon: <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" /> },
    error: { box: 'bg-red-500/10 border-red-500/30 text-red-300', icon: <XCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" /> },
    success: { box: 'bg-green-500/10 border-green-500/30 text-green-300', icon: <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" /> },
};

export function Notice({ kind = 'info', children, className = '' }: { kind?: keyof typeof NOTICE_STYLE; children: ReactNode; className?: string }) {
    const s = NOTICE_STYLE[kind];
    return (
        <div className={`p-3 rounded-xl border text-sm flex items-start gap-2 ${s.box} ${className}`}>
            {s.icon}
            <div className="min-w-0 flex-1">{children}</div>
        </div>
    );
}

export function StatTile({ label, value, sub, icon }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
    return (
        <div className="bg-space-700/50 rounded-xl p-4 border border-white/5">
            <div className="flex items-center gap-2 text-xs text-lunar-400 uppercase tracking-wider mb-1">
                {icon}{label}
            </div>
            <div className="font-space text-xl text-forge-gold break-words">{value}</div>
            {sub && <div className="text-xs text-lunar-400 mt-1">{sub}</div>}
        </div>
    );
}

/** Shows busy / error / last signature of a useTx() instance. */
export function TxStatus({ busy, error, lastTx, info }: { busy: string | null; error: string | null; lastTx: string | null; info?: string | null }) {
    if (!busy && !error && !lastTx && !info) return null;
    return (
        <div className="space-y-2 mt-3">
            {busy && (
                <div className="flex items-center gap-2 text-sm text-lunar-300">
                    <Loader2 className="w-4 h-4 animate-spin" /> {busy}… confirm in your wallet
                </div>
            )}
            {error && <Notice kind="error">{error}</Notice>}
            {info && !busy && <Notice kind="success">{info}</Notice>}
            {lastTx && !busy && !error && (
                <div className="text-xs text-lunar-400">Last transaction: <TxLink sig={lastTx} /></div>
            )}
        </div>
    );
}

/** Renders children only with a connected X1 wallet; otherwise a connect button. */
export function X1Gate({ children, why }: { children: ReactNode; why?: string }) {
    const { x1Connected, connectX1, isConnecting, error } = useWallet();
    if (x1Connected) return <>{children}</>;
    return (
        <div className="glass-card text-center py-10">
            <Zap className="w-10 h-10 text-mission-moon mx-auto mb-3" />
            <p className="text-lunar-300 mb-4">{why ?? 'Connect your X1 wallet to continue.'}</p>
            <button onClick={connectX1} disabled={isConnecting} className="btn-forge">
                {isConnecting ? 'Connecting…' : 'Connect X1 Wallet'}
            </button>
            {error && <p className="text-xs text-red-400 mt-3 break-words">{error}</p>}
        </div>
    );
}

export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
    return (
        <div className="flex justify-between gap-3 py-1 text-sm">
            <span className="text-lunar-400">{label}</span>
            <span className="text-white text-right min-w-0 break-words">{children}</span>
        </div>
    );
}
