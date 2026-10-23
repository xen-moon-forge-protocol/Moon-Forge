/**
 * Moon Forge — machine-readable facts (single source for the discoverability surfaces).
 *
 * scripts/prerender.mjs bundles this file and generates, at build time:
 *   dist/<route>/index.html (static HTML for readers without JavaScript), dist/llms.txt, dist/llms-full.txt,
 *   dist/sitemap.xml and the per-route JSON-LD / canonical / social tags.
 *
 * RULES MARKER: everything below describes the rules that are LIVE today (program tag program-2026-10-12, oracle v2).
 * A later rules change (new oracle version, program upgrade) is published here only AFTER it is live on X1; until then
 * only dated notices are allowed. Numbers mirror lib/protocol.ts (itself mirrored from programs/moon-forge/src/constants.rs);
 * a drift check compares the generated files against this module (T15-15).
 *
 * Pure data: no React, no web3 imports (it must load in plain Node).
 * Wording: follow the forbidden-word list in docs/WORDING.md (the prerender lint enforces it, and scripts/wording-check.mjs once it is published).
 *
 * public/links.json (T9-30) is the single source for the official URLs, the "never" list and the "verify you are on
 * the real site" facts; src/content/interim.ts carries the dated pause flags. Both are imported here, and the
 * assertions at the end of this file refuse to build when the identity facts below and links.json disagree.
 */
import linksJson from '../public/links.json';
import { INTERIM, NEUTRAL } from './content/interim';

export { INTERIM, DATED, NEUTRAL } from './content/interim';

const officialUrl = (id: string): string => {
    const l = linksJson.official.find((o) => o.id === id);
    if (!l) throw new Error(`public/links.json: no official link "${id}"`);
    return l.url;
};
export const SITE_URL: string = linksJson.site;
export const GITHUB_URL: string = officialUrl('github');
export const X_URL: string = officialUrl('x');

export const rules = {
    /** Git tag of the program source that is deployed on X1 mainnet. */
    program: 'program-2026-10-12',
    /** Oracle generation that seals the epochs described here. */
    oracle: 'v2',
    /** First day these rules were live on X1. */
    validFrom: '2026-10-12',
    /** Date the texts below were last checked against the live program. */
    describedAsOf: '2026-10-22',
} as const;

export const identity = {
    name: 'Moon Forge',
    legalName: 'Moon Forge Protocol',
    tagline: 'Any XEN, any chain → XNT on X1',
    description:
        'Burn XEN on Base, Optimism, Polygon, BSC or Avalanche and receive XNT on X1. Each chain’s XEN is valued at its own market; '
        + 'zero protocol fee on the burn path; every weekly epoch can be recomputed by anyone. Independent open-source project, no token.',
    programId: '57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9',
    /** MoonForgePortal v2, the same address on every supported EVM chain. */
    portal: '0x7b00f314aB48D223bee567181CA89c65126Bf6E9',
    /** PDA ["collection"] of the program: the Metaplex Core collection "Moon Forge Artifacts". */
    collectionPda: '7Re1n5DsnvyJnDTiaaZZ1f9G9REPRwb2Br7SYVYCfpzK',
    rewardVaultPda: 'CScsBfpj63Mppem9Bmddmfi87bkcAfeLevdSauYMDsHR',
    architectWallet: '7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd',
    x1Rpc: 'https://rpc.mainnet.x1.xyz',
    x1Explorer: 'https://explorer.mainnet.x1.xyz',
    license: 'MIT',
    licenseUrl: `${GITHUB_URL}/blob/main/LICENSE`,
    languages: ['Rust', 'TypeScript', 'Solidity'],
} as const;

/** Official places. Nothing else is official; nobody from Moon Forge messages, e-mails or calls anyone first. */
export const officialLinks = {
    site: SITE_URL,
    github: GITHUB_URL,
    x: X_URL,
    whitepaperMd: `${GITHUB_URL}/blob/main/docs/WHITEPAPER.md`,
    securityMd: `${GITHUB_URL}/blob/main/SECURITY.md`,
    reviewMd: `${GITHUB_URL}/blob/main/docs/REVIEW-2026-10.md`,
    knownIssuesMd: `${GITHUB_URL}/blob/main/docs/KNOWN-ISSUES.md`,
    linksJson: `${SITE_URL}links.json`,
    programSource: `${GITHUB_URL}/tree/main/programs/moon-forge/src`,
    programConstants: `${GITHUB_URL}/blob/main/programs/moon-forge/src/constants.rs`,
    portalSource: `${GITHUB_URL}/blob/main/contracts/MoonForgePortal.sol`,
    oracleSource: `${GITHUB_URL}/tree/main/oracle`,
    agentKit: `${GITHUB_URL}/tree/main/agents/kit`,
    skillFile: 'https://raw.githubusercontent.com/xen-moon-forge-protocol/Moon-Forge/main/agents/moon-forge-arena/SKILL.md',
    agentCard: `${SITE_URL}agent-card.json`,
    llms: `${SITE_URL}llms.txt`,
    llmsFull: `${SITE_URL}llms-full.txt`,
    epochIndex: `${SITE_URL}epochs/index.json`,
} as const;

export interface ChainFact {
    key: string;
    name: string;
    chainId: number;
    xenToken: string;
    /** false = no portal, and none is planned by this project. */
    live: boolean;
    explorer: string;
}

/** Five live chains (owner decision 2026-10-20). Ethereum and PulseChain: no portal; left to the community. */
export const chains: readonly ChainFact[] = [
    { key: 'base', name: 'Base', chainId: 8453, xenToken: '0xffcbF84650cE02DaFE96926B37a0ac5E34932fa5', live: true, explorer: 'https://basescan.org' },
    { key: 'optimism', name: 'Optimism', chainId: 10, xenToken: '0xeB585163DEbB1E637c6D617de3bEF99347cd75c8', live: true, explorer: 'https://optimistic.etherscan.io' },
    { key: 'polygon', name: 'Polygon', chainId: 137, xenToken: '0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e', live: true, explorer: 'https://polygonscan.com' },
    { key: 'bsc', name: 'BNB Chain', chainId: 56, xenToken: '0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e', live: true, explorer: 'https://bscscan.com' },
    { key: 'avalanche', name: 'Avalanche', chainId: 43114, xenToken: '0xC0C5AA69Dbe4d6DDdfBc89c0957686ec60F24389', live: true, explorer: 'https://snowtrace.io' },
    { key: 'ethereum', name: 'Ethereum', chainId: 1, xenToken: '0x06450dEe7FD2Fb8E39061434BAbCFC05599a6Fb8', live: false, explorer: 'https://etherscan.io' },
    { key: 'pulsechain', name: 'PulseChain', chainId: 369, xenToken: '0x8a7FDcA264e87b6da72D000f22186B4403081A2a', live: false, explorer: 'https://scan.pulsechain.com' },
];

export const liveChains = chains.filter((c) => c.live);
export const liveChainNames = liveChains.map((c) => c.name);

/** Epoch and payout rules enforced by the program (rules 2). */
export const epochRules = {
    cadence: 'weekly, scheduled Sunday 00:00 UTC and often later; weeks without burns publish nothing',
    minIntervalDays: 6,
    budgetPctOfFreePool: 10,
    rateCapK: 1.25,
    claimWindowDays: 90,
    scoring:
        'value(burn) = XEN amount × burn-hour price of that chain’s XEN (USD) × L / (L + V), where L is the XEN-side USD liquidity '
        + 'of the chain’s eligible pools and V the total spot value burned on that chain in the epoch. Scores are linear in value: '
        + 'splitting a burn across wallets changes nothing.',
    budgetLine: 'budget = min(10% of the FREE reward pool, total_score × rate_cap), computed on-chain; share = score × budget / total_score.',
    dustRule: 'A burn worth less than a millionth of a dollar after the liquidity discount scores zero.',
    priceClamp: 'Each chain’s price is clamped to ±50% of the median of its reference price over the last 4 epochs; the XNT price to ±50% of the previous epoch’s.',
} as const;

export interface TierFact { id: number; name: string; multiplier: number; vestingDays: number; penaltyPct: number }

export const tiers: readonly TierFact[] = [
    { id: 0, name: 'Launchpad', multiplier: 1, vestingDays: 0, penaltyPct: 0 },
    { id: 1, name: 'Orbit', multiplier: 2, vestingDays: 45, penaltyPct: 60 },
    { id: 2, name: 'Moon Landing', multiplier: 3, vestingDays: 180, penaltyPct: 75 },
];

/** Every fee and split (compile-time constants of the program). */
export const fees = {
    burnPathPct: 0,
    houseEdgePct: 2,
    edgeToPoolPct: 1,
    edgeToArchitectPct: 0.5,
    edgeToBankrollPct: 0.5,
    p2pRakePct: 2,
    rakeToPoolPct: 1,
    rakeToArchitectPct: 0.5,
    rakeToDrawPct: 0.5,
    secondaryRoyaltyPct: 5,
    keeperTipXnt: 0.002,
    keeperTipMinClaimXnt: 0.02,
    dropKeeperTipXnt: 0.01,
    maxExposurePct: 0.25,
    maxTotalExposurePct: 20,
    maxDailyLossPct: 10,
    houseWithdrawHours: 24,
} as const;

/** Artifact (Metaplex Core NFT) tiers under rules 2. */
export interface ArtifactFact { tier: number; name: string; element: string; supply: number; basePriceXnt: number; boostPct: number; weeklyChips: number }

export const artifacts: readonly ArtifactFact[] = [
    { tier: 0, name: 'Lunar Dust', element: 'Lunar', supply: 600, basePriceXnt: 10, boostPct: 5, weeklyChips: 5 },
    { tier: 1, name: 'Cosmic Shard', element: 'Cosmic', supply: 300, basePriceXnt: 25, boostPct: 10, weeklyChips: 15 },
    { tier: 2, name: 'Solar Core', element: 'Solar', supply: 90, basePriceXnt: 60, boostPct: 20, weeklyChips: 40 },
    { tier: 3, name: 'Void Anomaly', element: 'Void', supply: 10, basePriceXnt: 200, boostPct: 50, weeklyChips: 150 },
];

/** Split of the forge price actually paid (rules 2). */
export const forgeSplit = { floorPct: 50, poolPct: 40, lotteryPct: 5, architectPct: 5 } as const;

export const artifactRules = {
    pricing: 'Lunar Dust has a fixed price of 10 XNT. Cosmic Shard / Solar Core / Void Anomaly start at their base price, rise 5% per forge and fall ÷1.05 per full week without a forge, never below base and never above 100× base. The buyer signs a maximum price.',
    floors: 'Floors by origin: forged = half of the price paid; Lunar Dust from a Forge Drop = the drop value (≥ 5 XNT); Genesis airdrop = none. Recycling gives the floor back and frees the supply slot.',
    boost: 'Only an Artifact held by the same owner at two consecutive epoch snapshots counts, and only the best one per wallet. A boost shifts shares between burners of the same epoch and never raises the total.',
    trading: 'Artifacts are standard Metaplex Core assets in the "Moon Forge Artifacts" collection and can be traded on any Core marketplace that supports X1. Moon Forge runs no marketplace and shows no listings. A 5% royalty to the architect is declared on the collection (paid only where the marketplace honors it).',
    genesis: `Genesis airdrop: up to 120 Lunar Dust with no floor for the 444 X1 validator withdraw authorities published on-chain on 2026-10-12 (one time, final). ${INTERIM.genesisClaimPaused ? 'The claim is paused on this site until the final program upgrade. ' : ''}${NEUTRAL.genesisDeadline} The only Genesis claim is this site’s /artifacts/ page; any other "claim" link is not ours.`,
} as const;

export interface GameFact { name: string; kind: 'house' | 'p2p' | 'lottery' | 'house-backing'; summary: string; status: string }

export const games: readonly GameFact[] = [
    { name: 'Coin Flip', kind: 'house', summary: 'Pays 1.96×. Fixed 2% house edge: negative expected value.', status: 'live; keeper service level not yet promoted' },
    { name: 'High-Low', kind: 'house', summary: '1–95% chance, pays 0.98 / chance. Fixed 2% house edge.', status: 'live; keeper service level not yet promoted' },
    { name: 'Void Rush', kind: 'house', summary: '1.05×–100× targets, chance = 98% / target. Fixed 2% house edge.', status: 'live; keeper service level not yet promoted' },
    { name: 'Jackpot', kind: 'p2p', summary: 'A round starts at the first entry and closes 10 minutes later; a single-player round is fully refunded; 2% rake only when someone wins.', status: 'live' },
    { name: 'Artifact Duel', kind: 'p2p', summary: 'A live Artifact is the ticket; element hidden by commit-reveal; same or opposite element = draw with a full refund; the creator must reveal within 1 h.', status: 'live' },
    { name: 'Moon Wars', kind: 'p2p', summary: 'Player-vs-player card matches, perfect information, every move checked by the program, 2 minutes per turn, 2% rake.', status: 'free practice only; real-XNT matches are paused on the site' },
    { name: 'Burn Lottery', kind: 'lottery', summary: 'A round lasts 7 days from its first entry; weight = chips + 1-XNT tickets; the winner gets 50% of the vault; an unsettled round pays its prize to the burners’ pool.', status: 'live' },
    { name: 'Be the House', kind: 'house-backing', summary: 'Deposit XNT into the game bankroll and share its result; 0.5% of every house stake stays in it and it pays the winners. 24 h withdrawal cooldown. You can lose.', status: 'live' },
    { name: 'Predictions', kind: 'p2p', summary: 'XNT up/down rounds settled by an on-chain TWAP.', status: 'in the program, not offered by this site or the agent kit (read-only claim/refund view only); the round can be blocked or steered cheaply (known issue GAM-3)' },
];

export const gameRules = {
    randomness: 'House-game outcomes come from the hash of the slot after the bet: keccak("MOONFORGE_RNG" ‖ slotHash ‖ bet ‖ seed) mod 10000. The result is not known to the player or the protocol when the stake is locked; it is verifiable by anyone, and the producer of the drawing slot can influence the roll (until the program upgrade).',
    settlement: 'A house bet not settled within ~3 minutes counts as lost even if its roll was a win (the site settles immediately; the keeper is a safety net).',
    circuitBreaker: 'If the bankroll has lost 10% since the start of the UTC day, new house bets are refused until the next day. A bet can win at most 0.25% of the free bankroll.',
    sessionKeys: 'Session keys (bots) play house games only and can never withdraw; Jackpot, Burn Lottery, Duels and Moon Wars are entered by the wallet owner only.',
} as const;

/** Dated notices: facts that are true today but expected to change; they are removed only after the change is live. */
export interface NoticeFact { date: string; id: string; text: string }

export const notices: readonly NoticeFact[] = [
    {
        date: '2026-10-22', id: 'rules-v2',
        text: 'The live program and oracle are still version 2 (rules 2). A redesign of the weekly rewards is being prepared; this file will describe new rules only after they are live on X1 and the first epoch under them is published.',
    },
    {
        date: '2026-10-22', id: 'forge-drops',
        text: `Forge Drops (Lunar Dust drawn from 10% of each epoch budget, ≥ 5 XNT each) are part of rules 2 and are still sealed and paid by the v2 oracle; weekly lottery chips are a rule of the live program. ${NEUTRAL.oracleRules} ${NEUTRAL.programRules}`,
    },
    {
        date: '2026-10-22', id: 'moon-wars-paused',
        text: 'Real-XNT Moon Wars matches are paused on the site; free practice stays available.',
    },
    {
        date: '2026-10-22', id: 'house-keeper',
        text: 'House games are available but not promoted until a public keeper meets its service level for a week; see the known-issues notice on the Games page.',
    },
    {
        date: '2026-10-22', id: 'predictions-off',
        text: 'Predictions are in the program but not offered on the site (a round can be blocked or steered cheaply, known issue GAM-3); only a read-only claim/refund view of past rounds remains.',
    },
    ...(INTERIM.forgePaused || INTERIM.genesisClaimPaused ? [{
        date: INTERIM.noticeDate, id: 'forge-paused',
        text: `${INTERIM.forgePaused ? 'Forging Artifacts' : ''}${INTERIM.forgePaused && INTERIM.genesisClaimPaused ? ' and ' : ''}${INTERIM.genesisClaimPaused ? 'the Genesis claim' : ''} ${INTERIM.forgePaused && INTERIM.genesisClaimPaused ? 'are' : 'is'} paused on this site until the final program upgrade (${INTERIM.upgradeWhen}); the forge and claim buttons on /artifacts/ are disabled, while recycling an Artifact and the weekly chips claim stay open. The program itself still accepts forges from other clients.`,
    }] : []),
    {
        // T3-23: the one Genesis-specific notice; "no chips, no ticket" is scoped to Genesis Lunar Dust only.
        date: INTERIM.noticeDate, id: 'genesis',
        text: `Genesis Lunar Dust: ${INTERIM.genesisClaimPaused ? 'the claim is paused on this site until the final program upgrade. ' : ''}${NEUTRAL.genesisDeadline} After the upgrade a Genesis Lunar Dust is a free collectible with a cosmetic badge: no floor, no rebate, no burn boost, no chips, no ticket, and it is not needed to play any game; recycling it gives back only the record’s rent. Moon Forge never messages anyone about Genesis.`,
    },
    {
        date: '2026-10-22', id: 'upgrade-pending',
        text: `The program can still be upgraded by the architect wallet during the public test period. The upgrade key is to be burned ${INTERIM.freezeWhen}; the Start page reads the live value from X1.`,
    },
];

export const disambiguation: readonly string[] = [
    'Moon Forge is not XEN Prime (announced for Ethereum XEN only), not X1 Forge ($FORGE, an unrelated project on X1), and not "Moon Party" (an X1 event that was discussed in the XEN community and never took place).',
    'Moon Forge is not run by the XEN team, X1 Labs or the X1 team. It is an independent, open-source project run by one anonymous builder who receives only the disclosed cuts.',
    'Moon Forge has no token, no presale and no team allocation. Any "Moon Forge" token, presale, whitelist or airdrop claim page elsewhere is not ours.',
];

export const oldBurns =
    'Only burns made through the Moon Forge portals (from each chain’s start block) are paid. Past or legacy XEN burns made elsewhere, for example the burn records '
    + 'tracked by xen.pub or the 2024 plan to redeem Ethereum XEN burns, are not counted and cannot be claimed here. Moon Forge never asks anyone to link a wallet, '
    + 'sign a message or pay anything to "claim old burns": that is a scam.';

/** "What Moon Forge will never do" (T9-30 / T15-18): verbatim from public/links.json, the same list every surface renders. */
export const never: readonly string[] = linksJson.never;
/** "Nothing else is official" sentence, from public/links.json. */
export const notOfficial: string = linksJson.notOfficial;
/** The facts that identify the real Moon Forge (X-064), from public/links.json. */
export const verify = linksJson.verify;

export const risks: readonly string[] = [
    'Burned XEN is gone forever. There is no undo.',
    'You are paid in XNT, and its price moves.',
    'What a week pays depends on the pool and on how much others burn; nobody can promise an amount.',
    'Smart contracts can have bugs; there is no third-party audit (internal reviews are public). The program is upgradeable during the test period.',
    'The oracle could report false burns, bounded by the epoch budget; prices can be wrong (clamped to ±50% of recent reference prices).',
    'Be the House deposits can lose value when players win. Games have a fixed house edge.',
];

export const trust: readonly string[] = [
    'Trust is limited to a bounded oracle and, until it is burned, the upgrade key. The oracle can only publish epoch roots with their rate cap; each epoch is bounded by 10% of the free pool and by total_score × rate_cap, at least 6 days apart, with every input published and hash-committed.',
    `The upgrade authority is held by the architect wallet during the public test period; it is to be burned ${INTERIM.freezeWhen}. Until then it can replace the program code.`,
    'The keeper is permissionless: anyone can run it; it only triggers outcomes already determined.',
    'The architect key’s only privileged program action was setting the airdrop root once.',
    'The EVM portals have no owner, no fee, no pause and no upgrade; the source is verified as an exact match on Sourcify.',
    'The oracle and keeper run from one GitHub account. If GitHub suspended it, no new epoch could be published; XNT already in the reward pool would stay in the program; published epochs remain claimable for their 90-day window; Artifacts, games and vaults keep working from any frontend.',
];

export const verifyChecklist: readonly { title: string; text: string }[] = [
    { title: 'Burn portals have no owner, no fee, no pause and no upgrade', text: `Same address on every chain (${identity.portal}); source verified as an exact match on Sourcify for ${liveChainNames.join(', ')}.` },
    { title: 'Zero fee on the burn path', text: 'Burn, claim, vesting and Forge Drops pay nothing to anyone. The architect receives only the disclosed cuts from games and Artifact sales; every split is on the Transparency page and in constants.rs.' },
    { title: 'The money is where the site says it is', text: `Reward pool ${identity.rewardVaultPda} and the game bankroll are program accounts read live from X1.` },
    { title: 'Every payout can be recomputed', text: 'Each epoch file (burns, prices, liquidity, every leaf) is public and hash-committed on-chain. Anyone can run `cd oracle && npm run verify -- epoch-N.json --full` from the open source and get the same result.' },
    { title: 'No token, no presale, no team allocation', text: 'There is no token; Artifacts are sold by the program (5% of the price to the architect). The program can only pay what is in its vaults, within the limits above.' },
    { title: 'The program can still be upgraded (test period)', text: `The upgrade authority is the architect wallet; it is to be burned ${INTERIM.freezeWhen}. The Start page reads the live value from X1.` },
    { title: 'No third-party audit yet', text: 'The internal reviews (not independent) and every finding are public in docs/REVIEW-2026-10.md; known, unfixed findings and their status are in docs/KNOWN-ISSUES.md. Use amounts you can afford to lose.' },
];

export const steps: readonly { title: string; text: string }[] = [
    { title: 'Get an X1 wallet', text: 'On desktop, install the X1 Wallet extension. On mobile, use Backpack with the custom RPC https://rpc.mainnet.x1.xyz. MetaMask does not support X1. Copy your X1 address: it is where your XNT will arrive.' },
    { title: 'Have your XEN in a wallet you control', text: 'XEN sitting on an exchange cannot be burned: withdraw it first to an EVM wallet (MetaMask, Rabby, Trust…) on a supported chain, plus a few cents of that chain’s gas token.' },
    { title: 'Open The Forge, connect, and paste your X1 address', text: 'Choose the amount and a tier: Launchpad pays at claim (1×), Orbit vests over 45 days (2×), Moon Landing over 180 days (3×). Leaving early from a vesting tier costs 60% / 75% of the unvested part, so pick the one you will keep.' },
    { title: 'Confirm two transactions', text: 'First an approval for exactly the amount you burn (never unlimited), then the burn. The portal calls XEN’s own burn(): the supply really goes down. Your only cost is gas on that chain. Moon Forge takes no fee on this path. The burn transaction links your EVM address to your X1 address publicly and forever.' },
    { title: 'Wait for the Sunday epoch', text: 'The oracle values every burn of the week at its chain’s market price and publishes the result on X1, with the full data file anyone can recompute.' },
    { title: 'Receive XNT', text: 'The public keeper may submit your claim for you (its runs are irregular); claim on Missions yourself if it has not. Launchpad XNT lands in your X1 wallet; for Orbit and Moon Landing use "Withdraw vested" as it unlocks. Claim within 90 days.' },
];

export interface FaqFact { q: string; a: string }

/**
 * The FAQ. StartPage renders this exact list (no copy of its own), so the React page, the static /start/ and /faq/
 * pages and the FAQPage JSON-LD carry the same questions and answers by construction. The vitest that asserts it
 * (T9-8, "facts == FAQ") comes with the v3 batch; until then the equality rests on that single import.
 */
export const faq: readonly FaqFact[] = [
    { q: 'Is this XEN Prime? Is it run by the X1 team?', a: `No to both. Moon Forge is an independent, open-source project run by one anonymous builder who receives only the disclosed cuts. XEN Prime is announced for Ethereum XEN only; Moon Forge works with XEN on ${liveChainNames.join(', ')}. You can use both with different XEN.` },
    { q: 'Is this X1 Forge, or the "Moon Party"?', a: 'No. X1 Forge ($FORGE) is a separate, unrelated project on X1. "Moon Party" was an X1 event discussed in the XEN community that never took place; Moon Forge is not it and is not run by X1 Labs. Moon Forge has no token at all: if you see a "Moon Forge" token, presale or airdrop claim anywhere, it is not us. Official places: this site, the GitHub repository and the project’s X account.' },
    { q: 'Do my old XEN burns count?', a: 'No. Only burns made through the Moon Forge portal on a supported chain are paid. Burns you made before, or anywhere else (for example the records tracked by xen.pub, or the 2024 plan to redeem Ethereum XEN burns), are not counted and cannot be claimed here. Moon Forge never asks you to link a wallet, sign a message or pay a fee to "claim old burns": anyone who does is running a scam.' },
    { q: 'My X1 wallet is brand new. Where does a tiny payout go?', a: 'To your wallet, as long as it ends with at least about 0.00089 XNT (the chain’s minimum for an account). A smaller payment to an empty wallet is credited to your game balance instead; move it with Withdraw in the Games page (that needs your signature and a little XNT for the fee).' },
    { q: 'Can I calculate what I will get?', a: 'Yes, after the fact, exactly: the epoch file lists every burn, its price and your share, and the program checks the totals. Before the epoch you can only estimate, because your share depends on what others burn that week. The estimator on The Forge shows the upper bound, and the Transparency page shows, chain by chain, what the same burn is worth right now and why.' },
    { q: 'What do I get burning a little when others burn trillions?', a: 'Exactly your share of the value: 1% of the week’s value gets 1% of the budget, whatever the size. Under rules 2, small burners also enter the Forge Drops draw with a chance equal to their expected drop value ÷ 5 XNT.' },
    { q: 'Is there a minimum?', a: 'Any amount above zero can be burned. A burn worth less than a millionth of a dollar after the liquidity discount scores zero. A payout under 0.02 XNT carries no keeper tip. Today the project’s oracle and keeper submit every unclaimed payout, tipped or not, when they run; if yours is still unclaimed, claiming it yourself costs a network fee and a small rent deposit (the receipt’s rent can be recovered after the epoch closes). All your burns to one X1 address in one tier and epoch are paid as one payout.' },
    { q: 'Why not just sell my XEN?', a: 'You can, and sometimes that is better. On thin side-chain pools a sale loses a lot to slippage, and moving the dollars to X1 costs bridge fees and minimums. The estimator compares both routes for your amount.' },
    { q: 'Does splitting my XEN across wallets help?', a: 'Under the current rules, no: scores and drop chances are linear, so splitting changes nothing except your gas bill.' },
    { q: 'My XEN is on an exchange that is delisting it. What do I do?', a: 'Withdraw it to a wallet you control before the deadline. Then decide: hold, sell, or burn it here if its chain is supported.' },
    { q: 'When and how am I paid?', a: 'After the weekly epoch is published. The public keeper may submit the claim for you (its runs are irregular); otherwise claim on Missions within 90 days, or the amount goes back to the pool for everyone.' },
    { q: 'Is the Genesis airdrop real? Where do I claim it?', a: `Yes, for the 444 X1 validator withdraw authorities published on-chain on 2026-10-12: up to 120 Lunar Dust. ${INTERIM.genesisClaimPaused ? 'The claim is paused on this site until the final program upgrade (the claim button on /artifacts/ is disabled). ' : ''}${NEUTRAL.genesisDeadline} The only Genesis claim is this site’s /artifacts/ page. Any other "claim" link, message or form is not ours.` },
    { q: 'Can AI agents play?', a: 'Yes, with their own keypair, like anyone: the games are on-chain instructions. In Moon Wars every move is checked by the program; the creator currently has an edge (known issue GAM-4), and real-XNT matches are paused on the site at the moment (the program still accepts them). The agent kit on GitHub has a skill file, a JavaScript client and examples. Part of every pot goes to the burners’ pool.' },
    { q: 'Where do I ask for help?', a: 'X @MoonXenForge or an issue on GitHub. Nobody from Moon Forge will contact you first, and no chat group is official.' },
];

/** Whitepaper v2 summary (the full text is docs/WHITEPAPER.md in the repository). */
export const whitepaper: readonly { title: string; paragraphs: readonly string[] }[] = [
    { title: 'Problem', paragraphs: [
        `XEN lives on many EVM chains; X1 is an SVM chain whose token is XNT. XEN cannot be bridged to X1: reaching XNT means selling XEN, bridging USD and buying through thin pools, which is expensive for small holders. XEN Prime is announced for Ethereum XEN only. Moon Forge offers one path for the side chains (${liveChainNames.join(', ')}): burn XEN where it lives, receive XNT on X1. Ethereum and PulseChain have no portal and none is planned by this project.`,
    ] },
    { title: 'Flow', paragraphs: [
        'Burn on an EVM chain through MoonForgePortal v2 (no owner, fee, pause or upgrade). XEN’s own burn runs; the portal emits MissionStarted with your tier and 32-byte X1 key.',
        'Epoch (weekly, at least 6 days after the previous epoch; scheduled Sunday 00:00 UTC and often later): the oracle reads final burns, values them, builds a Merkle tree and publishes epoch-N.json, the root and the rate cap on X1. The program computes the budget.',
        'Claim: permissionless. The public keeper may submit claims (its runs are irregular); XNT always goes to the key in the leaf. Vesting starts when the leaf is claimed; vested XNT is withdrawn with "Withdraw vested" (anyone can push it).',
    ] },
    { title: 'Scoring and payout', paragraphs: [
        epochRules.scoring,
        'score = Σ value × tier multiplier × (1 + best eligible Artifact boost); rate_cap = 1.25 × XNT-per-USD × base_score / total_score; ' + epochRules.budgetLine,
        'So an epoch pays at most 1.25× / 2.5× / 3.75× the liquidity-adjusted market value burned (Launchpad / Orbit / Moon Landing), Forge Drops included. Artifact boosts only shift shares between burners of the same epoch and never raise the total.',
        epochRules.priceClamp,
        'Tiers: Launchpad 1×, paid at claim; Orbit 2×, linear over 45 days, 60% penalty on the unvested part if ejected (to the pool); Moon Landing 3×, linear over 180 days, 75% penalty. Ejecting at once always pays less than Launchpad would have.',
    ] },
    { title: 'Budget rules (rules 2)', paragraphs: [
        'Each epoch uses at most 10% of the free reward pool and at most total_score × rate_cap. The program refuses any claim that would exceed the epoch budget. Claims stay open 90 days; then the rest goes back to the pool.',
        'Forge Drops: 10% of the epoch budget, capped at 100 XNT (20 × 5 XNT), is part of the budget (not extra) and is drawn as Lunar Dust whose floor is the drop value (≥ 5 XNT). Chance = expected drop value ÷ 5 XNT; at or above 5 XNT the whole value becomes the floor. The seed is the hash of the first block at or after the publish slot + 4; if nobody seals within ~512 slots the drops are cancelled and the reserve goes back to the pool.',
        'Inflows: donations, 1% of house-game stakes, 1% of P2P pots and lottery tickets, 40% of Artifact forges, eject penalties, unclaimed or expired epoch budgets, cancelled Forge Drops, expired lottery prizes, orphan-Artifact floors, and the architect’s cut while its wallet is below rent exemption. Outflows: epoch claims, Forge Drops and keeper tips.',
        'No token, no inflation, no promised payout. If nobody funds the pool, burns pay nothing; the live pool is shown before you burn.',
    ] },
    { title: 'Games and fairness', paragraphs: [
        gameRules.randomness, gameRules.settlement,
        'House edge 2%: 1% reward pool, 0.5% architect, 0.5% bankroll. A bet can win at most 0.25% of the free bankroll; all unsettled payouts together stay under 20% of the bankroll. ' + gameRules.circuitBreaker,
        'Jackpot, Artifact Duel and Moon Wars: 2% rake only when someone wins (1% pool, 0.5% architect, 0.5% lottery). Burn Lottery tickets pay 2% at purchase; the winner gets 50% of the vault; an unsettled round pays its prize to the burners’ pool, never carried over.',
        'Chips: 1 per XNT actually received from burns, 1 per 10 XNT wagered in house games, and weekly per Artifact (5 / 15 / 40 / 150); weeks reset on Thursdays 00:00 UTC.',
        gameRules.sessionKeys,
    ] },
    { title: 'Artifacts (Metaplex Core NFTs)', paragraphs: [
        `Tiers (max alive / base price / boost / weekly chips): ${artifacts.map((a) => `${a.name} ${a.supply} / ${a.basePriceXnt} XNT / +${a.boostPct}% / ${a.weeklyChips}`).join('; ')}.`,
        `Forge split of the price paid: ${forgeSplit.floorPct}% floor kept inside the NFT (given back on recycle), ${forgeSplit.poolPct}% reward pool, ${forgeSplit.lotteryPct}% lottery, ${forgeSplit.architectPct}% architect. ` + artifactRules.pricing,
        artifactRules.floors, artifactRules.boost, artifactRules.trading, artifactRules.genesis,
    ] },
    { title: 'Fees', paragraphs: [
        'Burn → claim → vesting: 0%. The architect’s only income: 0.5% of house-game stakes, 0.5% of Jackpot / Duel / Moon Wars pots when someone wins and of every lottery ticket, 5% of forge prices, and a 5% royalty on secondary sales where honored. Nothing from burns, claims or Forge Drops. Keeper tips are paid by the pool, never by the player: 0.002 XNT per claim of ≥ 0.02 XNT submitted for someone else, 0.01 XNT per Forge Drop delivered for someone else.',
    ] },
    { title: 'Trust assumptions', paragraphs: [...trust] },
    { title: 'Risks', paragraphs: [...risks] },
];

/** Per-route metadata used by the prerender step and the sitemap. */
export interface RouteFact {
    path: string;
    title: string;
    description: string;
    /** false = noindex + canonical to `canonical` (aliases). */
    index: boolean;
    canonical?: string;
    /** true = the page needs a wallet; only a short static summary is rendered. */
    app?: boolean;
}

export const routes: readonly RouteFact[] = [
    { path: '/', title: 'Moon Forge | Any XEN, any chain → XNT on X1', description: identity.description, index: true },
    { path: '/start/', title: 'Start here | Moon Forge', description: 'What Moon Forge can really pay this week, how to burn XEN for XNT step by step, how to verify it yourself, the risks, and the questions people ask.', index: true },
    { path: '/faq/', title: 'FAQ | Moon Forge', description: 'Questions people ask about Moon Forge: XEN Prime, X1 Forge, old burns, minimums, payouts, the Genesis airdrop and AI agents.', index: true },
    { path: '/forge/', title: 'The Forge | Moon Forge', description: `Burn XEN on ${liveChainNames.join(', ')} through the Moon Forge portal and receive XNT on X1. Zero protocol fee on the burn path.`, index: true, app: true },
    { path: '/missions/', title: 'Missions | Moon Forge', description: 'Claim your weekly XNT, follow vesting and withdraw vested XNT.', index: true, app: true },
    { path: '/artifacts/', title: 'Artifacts | Moon Forge', description: 'Metaplex Core NFTs minted by the Moon Forge program: floor you can take back, burn boost, weekly chips and arena ticket.', index: true },
    { path: '/nft/', title: 'Artifacts | Moon Forge', description: 'Moon Forge Artifacts (alias of /artifacts/).', index: false, canonical: '/artifacts/' },
    { path: '/marketplace/', title: 'Artifacts | Moon Forge', description: 'Moon Forge runs no marketplace; Artifacts live at /artifacts/.', index: false, canonical: '/artifacts/' },
    { path: '/games/', title: 'Games | Moon Forge', description: 'On-chain XNT games of the Moon Forge program: house games with a fixed 2% edge, Jackpot, Artifact Duel, Moon Wars, Burn Lottery and Be the House.', index: true },
    { path: '/donate/', title: 'Donate | Moon Forge', description: 'A donation to the reward pool goes 100% to XEN burners through the weekly budget.', index: true, app: true },
    { path: '/transparency/', title: 'Transparency | Moon Forge', description: 'Program and upgrade authority, live configuration, vaults, lifetime counters, who can do what, every fee and split, key constants and epochs.', index: true },
    { path: '/whitepaper/', title: 'Whitepaper v2 | Moon Forge', description: 'Problem, flow, scoring and payout, budget rules, games and fairness, Artifacts, fees, trust assumptions and risks of Moon Forge v2.', index: true },
];

/** Extra sitemap entries (files, not routes). Relative to SITE_URL. */
export const sitemapFiles: readonly string[] = ['llms.txt', 'llms-full.txt', 'agent-card.json', 'epochs/index.json'];

export const facts = {
    INTERIM, rules, identity, officialLinks, chains, liveChains, epochRules, tiers, fees, artifacts, forgeSplit, artifactRules,
    games, gameRules, notices, disambiguation, oldBurns, never, notOfficial, verify, risks, trust, verifyChecklist, steps, faq, whitepaper, routes, sitemapFiles,
} as const;

// ── Drift guard: the identity facts above must equal public/links.json (one source for every surface, T9-30 / X-064) ──
{
    const V = linksJson.verify;
    const live = liveChains.map((c) => c.key).sort().join(',');
    const checks: [string, string, string][] = [
        ['programId', identity.programId, V.programId],
        ['portal', identity.portal, V.portal],
        ['collection', identity.collectionPda, V.collection],
        ['release tag', rules.program, V.release ?? ''],
        ['site', SITE_URL, V.site],
        ['github', GITHUB_URL, V.github],
        ['portal chains', live, [...V.portalChains].sort().join(',')],
    ];
    for (const [what, a, b] of checks) {
        if (a !== b) throw new Error(`src/facts.ts and public/links.json disagree on ${what}: "${a}" vs "${b}"`);
    }
}

export default facts;
