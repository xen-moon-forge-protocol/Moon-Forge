/**
 * Moon Forge Protocol - Constants v12.0
 *
 * Contract addresses, chain configs, tier definitions, and CWF defaults.
 * Official XEN addresses from DexScreener.
 * Rollout schedule: ETH/OP (Day 0) → BSC (Day 13) → Polygon/Avalanche (Day 26)
 *
 * Fee split (applied to early-exit penalties):
 *   93.5% Reward Pool | 1.0% Oracle | 2.0% Referrer | 2.0% Dev | 1.5% Escrow
 */

// ═══════════════════════════════════════════════════════════════════════════
//                              PROJECT LINKS (Configurable)
// ═══════════════════════════════════════════════════════════════════════════

// UPDATE THIS after creating your anonymous GitHub account and repo
// IMPORTANT: If you fork this project, read FORK.md for re-deployment steps.
export const GITHUB_URL = 'https://github.com/xen-moon-forge-protocol/Moon-Forge';

export const PROJECT_LINKS = {
    github: GITHUB_URL,
    whitepaper: '/whitepaper',
    docs: `${GITHUB_URL}/tree/main/docs`,
    contracts: `${GITHUB_URL}/tree/main/contracts`,
    x1Blockchain: 'https://x1.xyz',
    xenNetwork: 'https://xen.network',
} as const;

// ═══════════════════════════════════════════════════════════════════════════
//                              ROLLOUT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

// Launch date: April 8, 2026 (UTC) — community launch
export const LAUNCH_DATE = new Date('2026-04-08T00:00:00Z');

export const ROLLOUT_SCHEDULE = {
    ethereum:   0,  // Always active
    optimism:   0,  // Always active
    bsc:       13,  // Day 13 after launch
    polygon:   26,  // Day 26 after launch
    avalanche: 26,  // Day 26 after launch
    base:      39,  // Day 39 after launch
    pulsechain: 39, // Day 39 after launch
} as const;

export function getChainUnlockDate(chain: keyof typeof ROLLOUT_SCHEDULE): Date {
    const unlockDate = new Date(LAUNCH_DATE);
    unlockDate.setDate(unlockDate.getDate() + ROLLOUT_SCHEDULE[chain]);
    return unlockDate;
}

export function isChainActive(chain: keyof typeof ROLLOUT_SCHEDULE): boolean {
    // ETH and OP are always active from Day 0
    if (chain === 'ethereum' || chain === 'optimism') return true;

    // Other chains unlock after LAUNCH_DATE + rollout days
    const now = new Date();
    return now >= getChainUnlockDate(chain);
}

/** Returns true only if the portal contract has been deployed on this chain */
export function isPortalDeployed(chain: string): boolean {
    const c = CHAINS[chain];
    if (!c) return false;
    return (
        c.portalAddress !== '' &&
        c.portalAddress !== '0x0000000000000000000000000000000000000000'
    );
}

export function getDaysUntilUnlock(chain: keyof typeof ROLLOUT_SCHEDULE): number {
    // ETH/OP always return 0
    if (chain === 'ethereum' || chain === 'optimism') return 0;

    const now = new Date();
    const unlockDate = getChainUnlockDate(chain);
    const diff = unlockDate.getTime() - now.getTime();
    return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

// ═══════════════════════════════════════════════════════════════════════════
//                              CHAIN CONFIGURATIONS
// ═══════════════════════════════════════════════════════════════════════════

export interface ChainConfig {
    chainId: number;
    name: string;
    shortName: string;
    rpcUrl: string;
    explorer: string;
    xenToken: string;
    portalAddress: string;
    icon: string;
    color: string;
    rolloutDay: number;
    nativeTokenName?: string;
    nativeTokenSymbol?: string;
}

export const CHAINS: Record<string, ChainConfig> = {
    ethereum: {
        chainId: 1,
        name: 'Ethereum',
        shortName: 'ETH',
        rpcUrl: 'https://eth.llamarpc.com',
        explorer: 'https://etherscan.io',
        xenToken: '0x06450dEe7FD2Fb8E39061434BAbCFC05599a6Fb8', // Official XEN
        portalAddress: '0x0000000000000000000000000000000000000000', // [FILL BEFORE DEPLOY] MoonForgePortal address on Ethereum
        icon: '',
        color: '#627EEA',
        rolloutDay: 0,
    },
    optimism: {
        chainId: 10,
        name: 'Optimism',
        shortName: 'OP',
        rpcUrl: 'https://optimism.llamarpc.com',
        explorer: 'https://optimistic.etherscan.io',
        xenToken: '0xeB585163DEbB1E637c6D617de3bEF99347cd75c8', // Official XEN (xen.network)
        portalAddress: '0x0000000000000000000000000000000000000000', // [FILL BEFORE DEPLOY] MoonForgePortal address on Optimism
        icon: '',
        color: '#FF0420',
        rolloutDay: 0,
    },
    bsc: {
        chainId: 56,
        name: 'BNB Chain',
        shortName: 'BSC',
        rpcUrl: 'https://bsc-dataseed.binance.org',
        explorer: 'https://bscscan.com',
        xenToken: '0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e', // Official XEN
        portalAddress: '0x0000000000000000000000000000000000000000', // TBD
        icon: '',
        color: '#F0B90B',
        rolloutDay: 13,
    },
    polygon: {
        chainId: 137,
        name: 'Polygon',
        shortName: 'MATIC',
        rpcUrl: 'https://polygon.llamarpc.com',
        explorer: 'https://polygonscan.com',
        xenToken: '0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e', // Official XEN
        portalAddress: '0x0000000000000000000000000000000000000000', // TBD
        icon: '',
        color: '#8247E5',
        rolloutDay: 26,
    },
    avalanche: {
        chainId: 43114,
        name: 'Avalanche',
        shortName: 'AVAX',
        rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
        explorer: 'https://snowtrace.io',
        xenToken: '0xC0C5AA69Dbe4d6DDdfBc89c0957686ec60F24389', // Official XEN (xen.network)
        portalAddress: '0x0000000000000000000000000000000000000000', // TBD
        icon: '',
        color: '#E84142',
        rolloutDay: 26,
    },
    base: {
        chainId: 8453,
        name: 'Base',
        shortName: 'BASE',
        rpcUrl: 'https://mainnet.base.org',
        explorer: 'https://basescan.org',
        xenToken: '0xffcbF84650cE02DaFE96926B37a0ac5E34932fa5', // Official XEN (xen.network)
        portalAddress: '0x0000000000000000000000000000000000000000', // TBD
        icon: '',
        color: '#0052FF',
        rolloutDay: 39,
    },
    pulsechain: {
        chainId: 369,
        name: 'PulseChain',
        shortName: 'PLS',
        rpcUrl: 'https://rpc.pulsechain.com',
        explorer: 'https://scan.pulsechain.com',
        xenToken: '0x8a7FDcA264e87b6da72D000f22186B4403081A2a', // Official XEN (xen.network)
        portalAddress: '0x0000000000000000000000000000000000000000', // TBD
        icon: '',
        color: '#9945FF',
        rolloutDay: 39,
    },
    x1: {
        chainId: 0, // X1 is SVM (Solana Virtual Machine) — NOT EVM. No MetaMask chainId applies.
                    // Connection: new Connection('https://rpc.mainnet.x1.xyz') via @solana/web3.js
        name: 'X1 Blockchain',
        shortName: 'X1',
        rpcUrl: 'https://rpc.mainnet.x1.xyz', // ⚠️ Confirm with user before deploy
        explorer: 'https://explorer.mainnet.x1.xyz', // X1 Block Explorer
        xenToken: 'N/A (Burn on EVM chains — XNT is the reward token on X1)',
        portalAddress: '', // TBD — MoonForge Anchor program ID on X1 SVM (Base58, not 0x)
        icon: '',
        color: '#FFD700',
        rolloutDay: 0,
        nativeTokenName: 'XNT',
        nativeTokenSymbol: 'XNT',
    },
} as const;

// Ordered list of EVM chains for UI display (ordered by rollout day, then TVL)
export const EVM_CHAINS = ['ethereum', 'optimism', 'bsc', 'polygon', 'avalanche', 'base', 'pulsechain'] as const;

// ═══════════════════════════════════════════════════════════════════════════
//                              MISSION TIERS (v12.0 — Official Multipliers)
// ═══════════════════════════════════════════════════════════════════════════

export interface TierInfo {
    id: number;
    name: string;
    duration: number; // days
    multiplier: number;
    penalty: number; // percentage
    description: string;
    color: string;
    icon: string;
}

export const TIERS: TierInfo[] = [
    {
        id: 0,
        name: 'Launchpad',
        duration: 5,
        multiplier: 1.0,
        penalty: 0,
        description: 'Quick mission. Test the waters, zero penalty.',
        color: '#00d4ff',
        icon: '🚀',
    },
    {
        id: 1,
        name: 'Orbit',
        duration: 45,
        multiplier: 2.0,
        penalty: 20,
        description: 'Circle the Earth. Build momentum.',
        color: '#a855f7',
        icon: '🛸',
    },
    {
        id: 2,
        name: 'Moon Landing',
        duration: 180,
        multiplier: 3.0,
        penalty: 50,
        description: 'The ultimate destination. Maximum rewards.',
        color: '#ffd700',
        icon: '🌙',
    },
];

// ═══════════════════════════════════════════════════════════════════════════
//                              FEE STRUCTURE (v12.0)
//
//  Applied to early-exit penalties (ejectPilot) on X1 SVM Anchor program.
//  Normal deposits have ZERO fee.
//  With referrer:    93.5% pool + 1% oracle + 2% referrer + 2% dev + 1.5% escrow = 100%
//  Without referrer: 95.5% pool + 1% oracle +              2% dev + 1.5% escrow = 100%
//  Note: dev (2%) + escrow (1.5%) = 3.5% total dev allocation
// ═══════════════════════════════════════════════════════════════════════════

export const FEE_STRUCTURE = {
    rewardPool: 93.5,   // stays in vault — rewards patient pilots (95.5% if no referrer)
    oracle: 1.0,        // auto-fuel for oracle gas
    referrer: 2.0,      // referral reward (0 if no referrer — those 2% stay in pool)
    dev: 2.0,           // dev wallet — symmetric with referrer, transparent
    escrow: 1.5,        // DevEscrow — returned to pool every 4 epochs if platform grows
} as const;

// ═══════════════════════════════════════════════════════════════════════════
//                              NFT PRICING
// ═══════════════════════════════════════════════════════════════════════════

// NFT pricing model: 1 XNT per 1% boost across all tiers (consistent ratio).
// All tiers reach their "neutral price" at the same epoch size (~95 XNT avg allocation/pilot).
// Dynamic pricing (+5%/-5%) handles growth; floor = base price, enforced by contract.
export const ARTIFACT_TIERS = [
    { tier: 0, name: 'Lunar Dust',    maxSupply: 600, basePrice: 5,  boost: 5,  isDynamic: false, exclusiveToMissionTier: null },
    { tier: 1, name: 'Cosmic Shard',  maxSupply: 300, basePrice: 10, boost: 10, isDynamic: true,  exclusiveToMissionTier: null },
    { tier: 2, name: 'Solar Core',    maxSupply: 90,  basePrice: 20, boost: 20, isDynamic: true,  exclusiveToMissionTier: null },
    { tier: 3, name: 'Void Anomaly',  maxSupply: 10,  basePrice: 50, boost: 50, isDynamic: true,  exclusiveToMissionTier: 2 },
    // Void Anomaly: UI-only restriction — recommended for Moon Landing (Tier 2) pilots
] as const;

// ═══════════════════════════════════════════════════════════════════════════
//                   CWF — CHAIN WEIGHT FACTOR (v12.0)
//
//  Normalises XEN burned across chains by economic effort.
//  Formula: CWF = (AMP_max / AMP_current) × (gas_ETH / gas_chain)
//           then normalised so ETH = 1.0 as anchor.
//
//  These are the epoch-0 seed values. The oracle recalculates them
//  dynamically each epoch and publishes the snapshot in proofs.json.
// ═══════════════════════════════════════════════════════════════════════════

export const CWF_DEFAULTS: Record<string, number> = {
    ethereum:   1.000, // anchor — benchmark for all other chains
    optimism:   0.880, // near-deflationary (AMP=1), close to ETH value
    base:       0.850, // L2 Coinbase/Bedrock, similar to Optimism
    avalanche:  0.095, // ~10× more aXEN needed vs ETH
    bsc:        0.045, // ~22× more bXEN needed vs ETH
    pulsechain: 0.020, // high supply, ultra-cheap gas (similar to BSC)
    polygon:    0.010, // ~100× more mXEN needed (largest supply, lowest gas)
};

// ═══════════════════════════════════════════════════════════════════════════
//                    STREAK FLYWHEEL (v12.0)
//
//  Rewards pilots who burn XEN consistently across consecutive epochs.
//  Applied at oracle level — only redistributes within the fixed epoch budget.
//  No new XNT is created. Total XNT paid ≤ epochBudget always.
//
//  Formula: Streak_Mult = 1 + min(cap, coeff × log2(streakEpochs + 1))
//
//  Minimum burn per epoch to qualify for streak credit (dust-burn guard):
//    rawScore = √(xenNorm) ≥ minRawScore  →  xenNorm ≥ 100 CWF-normalised XEN
//
//  Per-chain XEN minimum at CWF seed values (adapts each epoch):
//    Ethereum   (1.000): ≥        100 XEN
//    Optimism   (0.880): ≥        115 XEN
//    Base       (0.850): ≥        118 XEN
//    Avalanche  (0.095): ≥      1,053 XEN
//    BSC        (0.045): ≥      2,223 XEN
//    PulseChain (0.020): ≥      5,000 XEN
//    Polygon    (0.010): ≥     10,000 XEN
// ═══════════════════════════════════════════════════════════════════════════

export const STREAK_CONFIG = {
    multiplierCap:  0.15,  // +15% maximum streak bonus (veteran cap at ~7 epochs)
    logCoefficient: 0.05,  // 0.05 × log2(streakEpochs + 1)
    breakHalveAt:   1,     // miss 1 epoch → streak = floor(streak / 2)
    breakResetAt:   2,     // miss 2+ consecutive epochs → streak = 0
    minRawScore:   10.0,   // √(xenNorm) ≥ 10 — prevents dust burns from gaming streak
} as const;

/**
 * Calculate streak multiplier for a given consecutive-epoch count.
 * Mirrors the oracle formula exactly — use in ROICalculator and tooltips.
 *
 *   0 epochs → 1.000× (no streak)
 *   1 epoch  → 1.050×
 *   3 epochs → 1.100×
 *   7+ epochs → 1.150× (cap)
 */
export function getStreakMultiplier(streakEpochs: number): number {
    return 1 + Math.min(
        STREAK_CONFIG.multiplierCap,
        STREAK_CONFIG.logCoefficient * Math.log2(streakEpochs + 1),
    );
}

/**
 * Minimum XEN to burn in one epoch on a given chain to qualify for streak.
 * Calibrated to the chain's CWF — automatically reflects each epoch's update.
 *
 * @param chainName  Key from CWF_DEFAULTS (e.g. 'ethereum', 'polygon')
 * @returns Minimum XEN (whole number, ceiled) required for streak eligibility
 */
export function getStreakMinXenForChain(chainName: string): number {
    const cwf = CWF_DEFAULTS[chainName] ?? 1.0;
    // rawScore = √(xenAmount × cwf) ≥ minRawScore
    // → xenAmount ≥ (minRawScore² / cwf)
    return Math.ceil((STREAK_CONFIG.minRawScore ** 2) / cwf);
}

// ═══════════════════════════════════════════════════════════════════════════
//                   PRICE FACTOR (PF) — CWF v2 (v12.0)
//
//  Adds XEN market price awareness to the CWF formula.
//  As burns reduce on-chain supply, XEN price tends to rise, increasing PF
//  and making future burns on that chain worth more points — creating a
//  natural flywheel: burn → supply ↓ → price ↑ → CWF ↑ → more XNT.
//
//  Full CWF formula: normalize( ISF × GCF × PF )
//    ISF = AMP_max / AMP_current   (inflation scarcity — primary)
//    GCF = gas_ETH / gas_chain     (economic effort — primary)
//    PF  = (price_chain_EMA / price_ETH_EMA) ^ 0.33  (secondary — dampened)
//
//  Cube-root exponent (0.33) ensures price is a differentiator but never
//  overrides AMP or gas as the main economic signal.
//
//  PF is computed by the oracle using a 7-epoch EMA from DexScreener.
//  The snapshot is published in proofs.json for full transparency.
// ═══════════════════════════════════════════════════════════════════════════

export const PRICE_FACTOR_CONFIG = {
    enabled:    true,  // false → PF = 1.0 for all chains (classic CWF v1)
    emaPeriods: 7,     // 7-epoch rolling average — resists short-term manipulation
    exponent:   0.33,  // cube-root dampening — AMP + gas remain primary drivers
    maxImpact:  5.0,   // hard cap: PF ∈ [0.20×, 5.00×]
} as const;

// ═══════════════════════════════════════════════════════════════════════════
//                              ABI FRAGMENTS
// ═══════════════════════════════════════════════════════════════════════════

export const PORTAL_ABI = [
    'function enterForge(uint256 amount, uint8 missionTier, string calldata x1TargetAddress, address referrer) external',
    'function enterForgeSimple(uint256 amount, uint8 missionTier, string calldata x1TargetAddress) external',
    'function totalBurned() view returns (uint256)',
    'function totalMissions() view returns (uint256)',
    'function getStats() view returns (uint256 burned, uint256 missions)',
    'event MissionStarted(address indexed pilot, uint256 amount, uint8 indexed missionTier, string x1TargetAddress, address referrer, uint256 timestamp)',
];

export const XEN_ABI = [
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
];

export const BASE_ABI = [
    'function initializeMission(uint256 amount, uint8 tier, address referrer, bytes32[] calldata proof) external',
    'function claimVested() external',
    'function ejectPilot() external',
    'function donate() external payable',
    'function getClaimable(address user) view returns (uint256)',
    'function getVestingInfo(address user) view returns (uint256 totalAmount, uint256 claimedAmount, uint256 claimable, uint256 startTime, uint8 tier, address referrer, bool initialized)',
    'function currentEpoch() view returns (uint256)',
    'event Donated(address indexed donor, uint256 amount)',
];

export const DEV_ESCROW_ABI = [
    'function getCycleProgress() view returns (uint256 thisCycleVol, uint256 prevCycleVol, uint256 progressBps, bool onTrack, uint256 epochsRemaining, uint256 pendingCarryOver)',
    'function settleCycle() external',
    'function cycleNumber() view returns (uint256)',
    'function lastCycleVolume() view returns (uint256)',
    'function CYCLE_LENGTH() view returns (uint256)',
    'function GOAL_TOLERANCE_BPS() view returns (uint256)',
    'event CycleSettled(uint256 indexed cycle, bool goalMet, uint256 amount, uint256 thisCycleVol, uint256 prevCycleVol)',
];

export const ARTIFACTS_ABI = [
    'function buyArtifact(uint8 artifactType, address referrer) external payable',
    'function equipArtifact(uint256 tokenId) external',
    'function unequipArtifact(uint256 tokenId) external',
    'function isEquipped(address user) view returns (bool)',
    'function getEquippedBonus(address user) view returns (uint256)',
    'function getPrice(uint8 artifactType) view returns (uint256)',
    'function getStock(uint8 artifactType) view returns (uint256)',
    'function getStats() view returns (uint256 minted, uint256 burned, uint256 active)',
    'function balanceOf(address owner) view returns (uint256)',
];

// ═══════════════════════════════════════════════════════════════════════════
//                              UTILITY
// ═══════════════════════════════════════════════════════════════════════════

export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD';

// ═══════════════════════════════════════════════════════════════════════════
//                         DONATION ADDRESSES (X1 SVM)
//
//  Two ways to support Moon Forge:
//    1. Pool donation  — 100% of XNT goes to the reward pool (via donate() in Anchor program)
//    2. Dev wallet     — directly supports the team building the protocol
//
//  Both are on X1 (SVM). Send XNT. No fees. No middleman. Transparent on-chain.
//
//  Pool donations: use the DonationPanel — it calls donate() in the Anchor program,
//  mathematically guaranteeing 100% reaches the vault (verifiable by anyone).
//
//  Dev wallet: standard X1 address — send XNT directly from X1 Wallet / Backpack.
// ═══════════════════════════════════════════════════════════════════════════

export const DONATION_ADDRESSES = {
    // Dev wallet (X1 SVM) — architect of the protocol; receives 2% of all early-exit penalties
    // Direct donations here support infrastructure, oracle ops, and Phase 2 NFT deployment.
    devWallet: '7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd',

    // Oracle wallet (X1 SVM) — runs the bridge between EVM burns and X1 rewards
    // Receives 1% of all early-exit penalties as gas compensation. Not a donation target.
    oracleWallet: 'J5CU45Didfq7ng9JHXyxYqN7TwAGjMgEyhUcrV7Aixba',

    // Pool reward vault — PDA derived from the Anchor program after deploy.
    // Donations via DonationPanel go here (100% guaranteed, no split).
    poolVault: 'CScsBfpj63Mppem9Bmddmfi87bkcAfeLevdSauYMDsHR',
} as const;

// Protocol program IDs on X1 SVM — fill after Anchor programs are deployed
// IMPORTANT: Forking? Visit FORK.md to learn how to update these for your own deployment.
export const PROTOCOL_CONTRACTS = {
    BASE:        '57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9', // MoonForge Anchor program (vault + vesting + games)
    ARTIFACTS:   '', // MoonArtifacts Anchor program (NFT boosters)  — Phase 2
    DEV_ESCROW:  '', // DevEscrow Anchor program                      — Phase 2
    TIME_LOCK:   '', // MoonTimeLock Anchor program                   — Phase 2
    // PDAs (derived from BASE program)
    PROTOCOL_STATE: '5dLsHmw6VvsbPhuHte6E2QJjm87oAWC1VxN43ngYfSGn',
    REWARD_VAULT:   'CScsBfpj63Mppem9Bmddmfi87bkcAfeLevdSauYMDsHR',
    BANKROLL_VAULT: 'GkrYzYc8KMzC97EELiX8DVf3BYcTw4nbAPdhXEzpfXUZ',
    DEV_ESCROW_VAULT: '8hAFXd1PhioLnR9VhsuCSC6m2Yi3yigpfLccuMFk6G7x',
} as const;

export const formatNumber = (n: number | bigint): string => {
    return new Intl.NumberFormat('en-US', {
        maximumFractionDigits: 2,
    }).format(Number(n));
};

export const formatXNT = (lamports: bigint | number): string => {
    const val = Number(lamports) / 1_000_000_000;
    return new Intl.NumberFormat('en-US', {
        maximumFractionDigits: 4,
        minimumFractionDigits: 2,
    }).format(val);
};

// Parse a human-readable XNT amount (e.g. "1.5") into lamports (bigint)
// X1 SVM uses 9 decimals — same as SOL on Solana (NOT 18 like EVM)
export const parseXNT = (amount: string): bigint => {
    const [whole, frac = ''] = amount.split('.');
    const wholeNum = BigInt(whole || '0') * 1_000_000_000n;
    const fracPadded = frac.padEnd(9, '0').slice(0, 9);
    return wholeNum + BigInt(fracPadded);
};

export const shortenAddress = (addr: string): string => {
    if (!addr) return '';
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
};
