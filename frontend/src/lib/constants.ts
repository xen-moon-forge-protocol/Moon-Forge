/**
 * Moon Forge v2 — frontend constants (EVM side + links + formatting).
 *
 * Every protocol rule (tiers, fees, odds, NFT tiers) lives in lib/protocol.ts,
 * mirrored from programs/moon-forge/src/constants.rs. Nothing economic is defined here.
 *
 * A chain is enabled in the UI as soon as its MoonForgePortal v2 address is set below.
 * 0x000…000 = portal not deployed yet = chain disabled (no burn can be sent).
 */

export const GITHUB_URL = 'https://github.com/xen-moon-forge-protocol/Moon-Forge';

export const PROJECT_LINKS = {
    github: GITHUB_URL,
    docs: `${GITHUB_URL}/tree/main/docs`,
    whitepaperMd: `${GITHUB_URL}/blob/main/docs/WHITEPAPER.md`,
    botsMd: `${GITHUB_URL}/blob/main/docs/BOTS.md`,
    securityMd: `${GITHUB_URL}/blob/main/SECURITY.md`,
    program: `${GITHUB_URL}/tree/main/programs/moon-forge/src`,
    programLib: `${GITHUB_URL}/blob/main/programs/moon-forge/src/lib.rs`,
    programConstants: `${GITHUB_URL}/blob/main/programs/moon-forge/src/constants.rs`,
    portal: `${GITHUB_URL}/blob/main/contracts/MoonForgePortal.sol`,
    oracle: `${GITHUB_URL}/tree/main/oracle`,
    x1Blockchain: 'https://x1.xyz',
    xenNetwork: 'https://xen.network',
    x1Wallet: 'https://chromewebstore.google.com/detail/x1-wallet/kcfmcpdmlchhbikbogddmgopmjbflnae',
} as const;

// ═══════════════════════════════════════════════════════════════════════════
//                              EVM CHAINS (burn side)
// ═══════════════════════════════════════════════════════════════════════════

export interface ChainConfig {
    key: string;
    chainId: number;
    name: string;
    shortName: string;
    rpcUrl: string;
    explorer: string;
    xenToken: string;
    /** MoonForgePortal v2. 0x000…000 = not deployed (chain disabled). */
    portalAddress: string;
    /** GeckoTerminal network id (used for the XEN market price in the Burn-vs-Sell estimator) */
    gecko: string;
    nativeSymbol: string;
    color: string;
}

const NOT_DEPLOYED = '0x0000000000000000000000000000000000000000';

export const CHAINS: Record<string, ChainConfig> = {
    ethereum: {
        key: 'ethereum', chainId: 1, name: 'Ethereum', shortName: 'ETH',
        rpcUrl: 'https://eth.llamarpc.com', explorer: 'https://etherscan.io',
        xenToken: '0x06450dEe7FD2Fb8E39061434BAbCFC05599a6Fb8',
        portalAddress: NOT_DEPLOYED, gecko: 'eth', nativeSymbol: 'ETH', color: '#627EEA',
    },
    optimism: {
        key: 'optimism', chainId: 10, name: 'Optimism', shortName: 'OP',
        rpcUrl: 'https://optimism.llamarpc.com', explorer: 'https://optimistic.etherscan.io',
        xenToken: '0xeB585163DEbB1E637c6D617de3bEF99347cd75c8',
        portalAddress: '0x7b00f314aB48D223bee567181CA89c65126Bf6E9', gecko: 'optimism', nativeSymbol: 'ETH', color: '#FF0420',
    },
    bsc: {
        key: 'bsc', chainId: 56, name: 'BNB Chain', shortName: 'BSC',
        rpcUrl: 'https://bsc-dataseed.binance.org', explorer: 'https://bscscan.com',
        xenToken: '0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e',
        portalAddress: NOT_DEPLOYED, gecko: 'bsc', nativeSymbol: 'BNB', color: '#F0B90B',
    },
    polygon: {
        key: 'polygon', chainId: 137, name: 'Polygon', shortName: 'POL',
        rpcUrl: 'https://polygon.llamarpc.com', explorer: 'https://polygonscan.com',
        xenToken: '0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e',
        portalAddress: NOT_DEPLOYED, gecko: 'polygon_pos', nativeSymbol: 'POL', color: '#8247E5',
    },
    avalanche: {
        key: 'avalanche', chainId: 43114, name: 'Avalanche', shortName: 'AVAX',
        rpcUrl: 'https://api.avax.network/ext/bc/C/rpc', explorer: 'https://snowtrace.io',
        xenToken: '0xC0C5AA69Dbe4d6DDdfBc89c0957686ec60F24389',
        portalAddress: NOT_DEPLOYED, gecko: 'avax', nativeSymbol: 'AVAX', color: '#E84142',
    },
    base: {
        key: 'base', chainId: 8453, name: 'Base', shortName: 'BASE',
        rpcUrl: 'https://mainnet.base.org', explorer: 'https://basescan.org',
        xenToken: '0xffcbF84650cE02DaFE96926B37a0ac5E34932fa5',
        portalAddress: '0x7b00f314aB48D223bee567181CA89c65126Bf6E9', gecko: 'base', nativeSymbol: 'ETH', color: '#0052FF',
    },
    pulsechain: {
        key: 'pulsechain', chainId: 369, name: 'PulseChain', shortName: 'PLS',
        rpcUrl: 'https://rpc.pulsechain.com', explorer: 'https://scan.pulsechain.com',
        xenToken: '0x8a7FDcA264e87b6da72D000f22186B4403081A2a',
        portalAddress: NOT_DEPLOYED, gecko: 'pulsechain', nativeSymbol: 'PLS', color: '#9945FF',
    },
};

/** Display order of the EVM chains. */
export const EVM_CHAINS = ['ethereum', 'optimism', 'bsc', 'polygon', 'avalanche', 'base', 'pulsechain'] as const;

/** True only when a real MoonForgePortal v2 address is configured for this chain. */
export function isPortalDeployed(chain: string): boolean {
    const c = CHAINS[chain];
    if (!c) return false;
    return /^0x[0-9a-fA-F]{40}$/.test(c.portalAddress) && c.portalAddress.toLowerCase() !== NOT_DEPLOYED;
}

export const chainById = (chainId: number | null | undefined) =>
    Object.values(CHAINS).find((c) => c.chainId === chainId) ?? null;

// ═══════════════════════════════════════════════════════════════════════════
//                              FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

export const formatNumber = (n: number | bigint, maxFrac = 2): string =>
    new Intl.NumberFormat('en-US', { maximumFractionDigits: maxFrac }).format(Number(n));

/** lamports → "1,234.5678" (no unit). null/undefined → "--". */
export const formatXNT = (lamports: bigint | number | null | undefined, maxFrac = 4): string => {
    if (lamports === null || lamports === undefined) return '--';
    const val = Number(lamports) / 1_000_000_000;
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: maxFrac, minimumFractionDigits: 0 }).format(val);
};

export const formatUSD = (usd: number | null | undefined): string => {
    if (usd === null || usd === undefined || !isFinite(usd)) return '--';
    const digits = usd !== 0 && Math.abs(usd) < 1 ? 4 : 2;
    return '$' + new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 2 }).format(usd);
};

/** Parse a human-readable XNT amount (e.g. "1.5") into lamports (9 decimals). */
export const parseXNT = (amount: string): bigint => {
    const [whole, frac = ''] = amount.trim().split('.');
    const wholeNum = BigInt(whole || '0') * 1_000_000_000n;
    const fracPadded = frac.padEnd(9, '0').slice(0, 9);
    return wholeNum + BigInt(fracPadded || '0');
};

export const shortenAddress = (addr: string | null | undefined, head = 6, tail = 4): string => {
    if (!addr) return '';
    return addr.length <= head + tail + 3 ? addr : `${addr.slice(0, head)}...${addr.slice(-tail)}`;
};

export const formatDuration = (seconds: number): string => {
    if (!isFinite(seconds) || seconds <= 0) return '0s';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
};
