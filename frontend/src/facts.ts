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
    describedAsOf: '2026-11-02',
} as const;

export const identity = {
    name: 'Moon Forge',
    legalName: 'Moon Forge Protocol',
    /** Five chains only (Base, Optimism, Polygon, BSC, Avalanche): never "any XEN, any chain" (docs/WORDING.md, Chains). */
    tagline: 'Side-chain XEN → XNT on X1',
    description:
        'Burn XEN on Base, Optimism, Polygon, BSC or Avalanche through XEN’s own burn() and receive XNT on X1 from a public reward pool: '
        + 'one more path for XEN holders. Each chain’s XEN is valued at its own market; zero protocol fee on the burn path; every weekly '
        + 'epoch can be recomputed by anyone. Independent open-source project, no token.',
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
    /** written by the prerender at every build from the published epoch files (src/lib/counter.ts) */
    counter: `${SITE_URL}counter.json`,
    /** the plain guide (burns, the pool, Artifacts, games, chains, control, checks, risks) */
    howItWorks: `${GITHUB_URL}/blob/main/docs/HOW-IT-WORKS.md`,
    /** the final upgrade's announcement and changelog (dated) */
    upgradeMd: `${GITHUB_URL}/blob/main/docs/UPGRADE-2026-11.md`,
    /** the hourly week-so-far feed (rules 3 only: served with the site from the first v3 window; a 404 before) */
    weekFeed: `${SITE_URL}feed/week-so-far.json`,
    /** the agent kit's quote (quoteBurn) and the feed contract */
    kitBurn: `${GITHUB_URL}/blob/main/agents/kit/burn.mjs`,
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
    { name: 'Coin Flip', kind: 'house', summary: 'Pays 1.96×. Fixed 2% house edge: negative expected value.', status: 'live on the current program (settle your own bet within about 3 minutes); from the final upgrade (planned 2026-11-18) shown on the site only while the chain shows a live house keeper' },
    { name: 'High-Low', kind: 'house', summary: '1–95% chance, pays 0.98 / chance. Fixed 2% house edge.', status: 'live on the current program (settle your own bet within about 3 minutes); from the final upgrade (planned 2026-11-18) shown on the site only while the chain shows a live house keeper' },
    { name: 'Void Rush', kind: 'house', summary: '1.05×–100× targets; the chance is 98% / target rounded down to 0.01%, so most targets pay back slightly under 98% (the worst 97.01%). A house edge of 2% or a little more.', status: 'live on the current program (settle your own bet within about 3 minutes); from the final upgrade (planned 2026-11-18) shown on the site only while the chain shows a live house keeper' },
    { name: 'Jackpot', kind: 'p2p', summary: 'A round starts at the first entry and closes 10 minutes later; a single-player round is fully refunded; 2% rake only when someone wins.', status: 'live' },
    { name: 'Artifact Duel', kind: 'p2p', summary: 'A live Artifact is the ticket; element hidden by commit-reveal; same or opposite element = draw with a full refund; the creator must reveal within 1 h.', status: 'live' },
    { name: 'Moon Wars', kind: 'p2p', summary: 'Player-vs-player card matches, perfect information, every move checked by the program, 2 minutes per turn, 2% rake.', status: 'free practice only; real-XNT matches are paused on the site' },
    { name: 'Burn Lottery', kind: 'lottery', summary: 'A round lasts 7 days from its first entry; weight = chips + 1-XNT tickets; the winner gets 50% of the vault; an unsettled round pays its prize to the burners’ pool.', status: 'live' },
    { name: 'Be the House', kind: 'house-backing', summary: 'Deposit XNT into the game bankroll and share its result; 0.5% of every house stake stays in it and it pays the winners. 24 h withdrawal cooldown. You can lose.', status: 'live' },
    { name: 'Predictions', kind: 'p2p', summary: 'XNT up/down rounds settled by an on-chain TWAP.', status: 'in the program, not offered by this site or the agent kit (read-only claim/refund view only); the program still accepts entries sent to it directly, with the same 2% rake; a round can be blocked or steered cheaply (known issue GAM-3)' },
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
        text: 'The live program and oracle are still version 2 (rules 2); every undated rule in this file is a rule 2. The v3 rules are already published (docs/HOW-IT-WORKS.md, docs/UPGRADE-2026-11.md) and apply from the epoch of 2026-11-22 (planned); every sentence that describes them carries that date.',
    },
    {
        date: '2026-11-02', id: 'final-upgrade',
        text: 'The final program upgrade is planned for Wednesday 2026-11-18, 16:00–20:00 UTC (moved from 2026-11-11; the same hours a week later if a gate is not green), and the first weekly epoch under the v3 reward rules for Sunday 2026-11-22. Burns made after the last epoch under the current rules is published (planned Sunday 2026-11-15) are paid under the v3 rules. The upgrade key is then burned (the freeze): earliest 2026-12-02, no later than 2026-12-31. Every planned rule is published in docs/UPGRADE-2026-11.md and explained in docs/HOW-IT-WORKS.md; the key questions give the dated answers.',
    },
    {
        date: '2026-10-22', id: 'forge-drops',
        text: `Forge Drops (Lunar Dust drawn at random from 10% of each epoch budget, ≥ 5 XNT each; a random draw: 18+ and only where such draws are legal) are part of rules 2 and are still sealed and paid by the v2 oracle; weekly lottery chips are a rule of the live program. ${NEUTRAL.oracleRules} ${NEUTRAL.programRules}`,
    },
    {
        date: '2026-10-22', id: 'moon-wars-paused',
        text: 'Real-XNT Moon Wars matches are paused on the site; free practice stays available.',
    },
    {
        date: '2026-11-02', id: 'house-keeper',
        text: 'House games and the Jackpot are open under the live program (18+ and only where legal; settle your own house bet: one not settled within about 3 minutes counts as lost). From the final upgrade (planned 2026-11-18) the site reads the house keeper seat from X1 on every visit and shows them only while it is live: armed, bonded with at least 20 XNT, active within 28 days, no bond withdrawal announced, at most 32 draws waiting, and its service levels kept on the bets pending now. No keeper is armed at the upgrade.',
    },
    {
        date: '2026-10-22', id: 'predictions-off',
        text: 'Predictions are in the program but not offered on the site or in the agent kit (a round can be blocked or steered cheaply, known issue GAM-3); only a read-only claim/refund view of past rounds remains. The program still accepts entries sent to it directly and takes the same 2% rake when someone wins (18+, where legal).',
    },
    ...(INTERIM.forgePaused || INTERIM.genesisClaimPaused ? [{
        date: INTERIM.noticeDate, id: 'forge-paused',
        text: `${INTERIM.forgePaused ? 'Forging Artifacts' : ''}${INTERIM.forgePaused && INTERIM.genesisClaimPaused ? ' and ' : ''}${INTERIM.genesisClaimPaused ? 'the Genesis claim' : ''} ${INTERIM.forgePaused && INTERIM.genesisClaimPaused ? 'are' : 'is'} paused on this site until the final program upgrade (${INTERIM.upgradeWhen}); the forge and claim buttons on /artifacts/ are disabled, while recycling an Artifact and the weekly chips claim stay open. The program itself still accepts forges from other clients.`,
    }] : []),
    {
        // T3-23: the one Genesis-specific notice; "no chips, no ticket" is scoped to Genesis Lunar Dust only.
        date: INTERIM.noticeDate, id: 'genesis',
        text: `Genesis Lunar Dust: ${INTERIM.genesisClaimPaused ? 'the claim is paused on this site until the final program upgrade. ' : ''}${NEUTRAL.genesisDeadline} After the upgrade a Genesis Lunar Dust is a collectible with a cosmetic badge: no floor, no rebate, no burn boost, no chips, no ticket, and it is not needed to play any game; recycling it gives back only the record’s rent. Moon Forge never messages anyone about Genesis.`,
    },
    {
        date: '2026-10-22', id: 'upgrade-pending',
        text: `The program can still be upgraded by the architect wallet during the public test period. The upgrade key is to be burned ${INTERIM.freezeWhen}; the Start page reads the live value from X1.`,
    },
];

/**
 * Other projects (docs/WORDING.md §3 "Other projects", owner rule 2026-11-02): one neutral sentence to prevent confusion,
 * never a comparison, a ranking or a description of another project's scope, chains, dates or past.
 */
export const disambiguation: readonly string[] = [
    'Moon Forge is independent and open source. It is separate from X1 Labs, the XEN team and every other XEN or X1 project; each project has its own rules, and none speaks for the others. Moon Forge is not the "Moon Party". Moon Forge and X1 Forge are separate projects with similar names.',
    'Moon Forge is not run by the XEN team, X1 Labs or the X1 team. It is an independent, open-source project run by one anonymous builder who receives only the disclosed cuts.',
    'Moon Forge has no token, no token airdrop, no presale and no team allocation. The only airdrop is the Genesis airdrop: up to 120 Lunar Dust NFTs with no floor for the X1 validator withdraw authorities published on 2026-10-12, claimed only on this site’s /artifacts/ page. Any "Moon Forge" token, presale, whitelist or other airdrop claim page is not ours.',
];

/** The position (docs/WORDING.md §3 "Other projects"): one more path, alongside the others. */
export const position =
    'Everyone around XEN and X1 wants the same thing: a real use for XEN. Not everyone takes the same path. Moon Forge is one more way, alongside the others: '
    + 'it works with XEN on Base, Optimism, Polygon, BSC and Avalanche, burn by burn, under one public rule. '
    + 'Holders can use several ways with different parts of their XEN (each XEN can be burned only once).';

/**
 * The real scale (owner request 2026-11-02): read on X1 on 2026-11-02, reward pool 6,475,019,443 lamports. Rules 2 pay at most 10% of
 * the free pool per epoch, the v3 rules 8%. Shown first wherever a payout could be quoted; the live number is on the Start page.
 */
export const SCALE_DATE = '2026-11-02';
const SCALE_SHORT = 'The pool is small: on 2026-11-02 it held about 6.5 XNT, so one week can pay at most about 0.5 to 0.65 XNT to all burners together. No payout is promised.';
const SCALE_WEEK = 'on 2026-11-02 the reward pool held about 6.5 XNT, so one week could pay at most about 0.65 XNT to all burners together under the current rules (10% of the free pool) and about 0.5 XNT under the v3 rules (8%).';
export const scale =
    'Real scale (2026-11-02): the reward pool held about 6.5 XNT, so one week can pay at most about 0.65 XNT to all burners together under the current rules (10% of the free pool) '
    + 'and about 0.5 XNT under the v3 rules (8%), however much is burned. No payout is promised. Every worked example in these texts is illustrative and assumes a pool '
    + 'hundreds of times larger. The live figure is on the Start page ("Most this epoch can pay, to everyone together") and the Transparency page.';

export const oldBurns =
    'Fresh burns only: only burns made through the Moon Forge portals (from each chain’s start block) are paid, and each one is recorded in XEN’s own burn ledger '
    + '(userBurns, on the burning address) on its chain. Burns made before the portals existed, or anywhere else, are not counted and cannot be claimed here. '
    + 'Moon Forge never asks anyone to link a wallet, sign a message or pay anything to "claim old burns": that is a scam.';

/** Games and age (docs/WORDING.md §3 "Games"; the site's play notice). */
export const ageNotice =
    'Games are for adults only: 18 or older (or the legal age for games of chance where you live), and only where such games are legal. You can lose the whole stake; '
    + 'house games have a fixed 2% edge, so players as a group lose. The site’s age and jurisdiction check is self-attested and stored only in the browser.';

/**
 * Legacy Pilot (oracle/src/legacy.ts; disclosure in docs/HOW-IT-WORKS.md §6). Dated and conditional: armed only once the
 * snapshot's sha256 is pinned in the oracle (LEGACY_SNAPSHOT_SHA256) before the first v3 epoch is built.
 */
export const legacyPilot =
    'Legacy Pilot (planned, dated): a one-time recognition for EVM addresses that burned XEN before 2026-11-01 00:00 UTC on Ethereum, Base, Optimism, Polygon, BSC or Avalanche '
    + '(recorded by XEN’s own contract as a transfer to the zero address). From the first epoch under the v3 rules (planned 2026-11-22), and only if the public list '
    + 'deployments/legacy-burners.json is built and its sha256 pinned in the oracle before that epoch is built (not yet done on 2026-11-02). (1) The first new burn of a '
    + 'listed address on one of the five chains, paid under the rule (burns paid under the current rules do not count), receives up to 50% more than the normal rules pay it, '
    + 'as Launchpad XNT, once per address; the top-ups come only from the week’s capacity left after every normal payout (together at most 25% of that leftover, none in '
    + 'a week the pool falls short), so nobody receives less in the week one is paid, and the pool then grows a little more slowly. (2) An X1 wallet named in a burn of a '
    + 'listed address: the first new Artifact (forged after the final upgrade, in the week of such a burn or later) that it holds at a weekly snapshot receives 20% of its '
    + 'forge price from the extra pot, only from what that pot’s weekly release leaves after the normal holder rebates, paid over later weeks when one week is not enough; '
    + 'once per wallet and once per address. Old burns themselves are still not paid, and nothing has to be claimed, signed or paid for it.';

/**
 * The hourly week-so-far feed (src/lib/quote.ts WeekSoFarFeed; agents/kit/burn.mjs FEED CONTRACT) and how a quote is computed
 * from it (oracle/src/rewards.ts, rules 3). Rules 3 only: the file exists from the first v3 window.
 */
export const quoteFeed = {
    today: 'No file quotes a burn today: under the current rules the estimator on The Forge shows an estimate only. On 2026-11-02 one week could pay at most about 0.65 XNT to all burners together (about 0.5 XNT under the v3 rules).',
    when: 'From the first window under the v3 rules (after the final upgrade, planned 2026-11-18; first v3 epoch planned 2026-11-22) the oracle rewrites this file every hour; before that it does not exist (HTTP 404) and no quote exists. It must continue the newest epoch file (prevEpoch, prevDataHash); asOf is its time (X1 unix seconds).',
    recipe: [
        'XEN price (USD per XEN) = min(readings.xen["<chainId>"][0] (24-hour median), readings.xen["<chainId>"][1] (last close), chains[<chain>].capE18) / 10^18; when readings.xen["<chainId>"] is null, chains[<chain>].spotE18 / 10^18.',
        'spot (USD) = XEN amount × XEN price.',
        'L = the chain’s liquidity for the week, fixed at the previous build (chains[].L.next of the previous epoch file); S = the chain’s curve memory: chains[<chain>].S + chains[<chain>].hourSpot, halved every 336 hours since chains[<chain>].hour (unix hours); in that same hour use S = chains[<chain>].S and add chains[<chain>].hourSpot to V. L, S and hourSpot are micro-USD (divide by 10^6).',
        'counted (USD) = spot × L² / ((L + S) × (L + S + V)), V = everything burned on that chain in that hour, the new burn included.',
        'XNT price (USD) = max(readings.xnt[0], readings.xnt[1], xnt.floorE18) / 10^18; when readings.xnt is null, xnt.buildE18 / 10^18.',
        'Launchpad XNT = 1.25 × counted / XNT price; Orbit 2× that (vesting 45 days), Moon Landing 3× that (vesting 180 days).',
        'Binding only for the part that fits today’s room: capacity.cash × (d + 1) / 7 − capacity.senior lamports (1 XNT = 10^9 lamports), d = whole days since window.startTs, at most capacity.cash; the rest is paid only from the week’s leftover, which is not promised.',
    ],
    example: 'Example (illustrative numbers; it assumes a week whose capacity is hundreds of times today’s, while on 2026-11-02 a whole week could pay all burners together only about 0.5 XNT): 1,000,000,000,000 XEN on BNB Chain (56). readings.xen["56"] = ["102000000", "100000000"], capE18 "131250000" → price $1.00e-10, spot $100. '
        + 'L = 3600000000 micro-USD ($3,600), S = 0, no other burn that hour → counted = 3,600² × 100 / (3,600 × 3,700) = $97.30. '
        + 'readings.xnt = ["240000000000000000", "250000000000000000"], floorE18 "156000000000000000" → XNT $0.25. '
        + 'Launchpad = 1.25 × 97.30 / 0.25 = 486.49 XNT (Orbit 972.97, Moon Landing 1,459.46), binding if today’s room is at least that.',
    kit: 'The agent kit’s quoteBurn() computes the same number from the feed and the previous epoch file, and refuses a feed that is stale or does not continue the newest epoch file.',
} as const;

/** "What Moon Forge will never do" (T9-30 / T15-18): verbatim from public/links.json, the same list every surface renders. */
export const never: readonly string[] = linksJson.never;
/** "Nothing else is official" sentence, from public/links.json. */
export const notOfficial: string = linksJson.notOfficial;
/** The X account's note (no posts planned; posts dated before 2026-10-01 are outdated), from public/links.json. */
export const xNote: string = linksJson.official.find((l) => l.id === 'x')?.note ?? '';
/** The facts that identify the real Moon Forge (X-064), from public/links.json. */
export const verify = linksJson.verify;

export const risks: readonly string[] = [
    'Burned XEN is gone forever. There is no undo.',
    'The pool is small: on 2026-11-02 it held about 6.5 XNT, so one week can pay at most about 0.65 XNT to all burners together.',
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
    { title: 'Zero fee on the burn path', text: 'You pay no fee on a burn, a claim, vesting or a Forge Drop. The reward pool pays small running costs (keeper tips); the architect receives only the disclosed cuts from games and Artifact sales, nothing from burns, claims or the pool; every split is on the Transparency page and in constants.rs.' },
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
    { q: 'Can I use Moon Forge alongside other XEN programs?', a: 'Yes. Moon Forge is one option among several in the XEN and X1 ecosystem and replaces none of them. Each XEN can be burned only once, so holders who use several paths use a different part of their XEN for each. A burn here is paid only under Moon Forge’s rules; Moon Forge does not promise that it counts in any other program, so check each program’s own rules.' },
    { q: 'I burned XEN before Moon Forge. Is there anything for me?', a: `Old burns are not paid here. A separate, one-time Legacy Pilot is planned for addresses that burned XEN before 2026-11-01 00:00 UTC: up to 50% more on their first new burn through a Moon Forge portal (from the same EVM address, on one of the five chains), paid only from capacity the normal payouts leave unused, and 20% of the price of a first new Artifact held by a wallet such a burn names, paid only from what the extra pot’s weekly release leaves; from the first epoch under the v3 rules (planned 2026-11-22) and only once its public address list is built and pinned. Nothing has to be claimed, signed or paid for it; anyone asking you to is running a scam.` },
    { q: 'My X1 wallet is brand new. Where does a tiny payout go?', a: 'To your wallet, as long as it ends with at least about 0.00089 XNT (the chain’s minimum for an account). A smaller payment to an empty wallet is credited to your game balance instead; move it with Withdraw in the Games page (that needs your signature and a little XNT for the fee).' },
    { q: 'Can I calculate what I will get?', a: 'Yes, after the fact, exactly: the epoch file lists every burn, its price and your share, and the program checks the totals. Before the epoch you can only estimate, because your share depends on what others burn that week. The estimator on The Forge shows the upper bound, and the Transparency page shows, chain by chain, what the same burn is worth right now and why.' },
    { q: 'Is there a minimum?', a: 'Any amount above zero can be burned. A burn worth less than a millionth of a dollar after the liquidity discount scores zero. A payout under 0.02 XNT carries no keeper tip. Today the project’s oracle and keeper submit every unclaimed payout, tipped or not, when they run; if yours is still unclaimed, claiming it yourself costs a network fee and a small rent deposit (the receipt’s rent can be recovered after the epoch closes). All your burns to one X1 address in one tier and epoch are paid as one payout.' },
    { q: 'Why not just sell my XEN?', a: 'You can, and sometimes that is better. On thin side-chain pools a sale loses a lot to slippage, and moving the dollars to X1 costs bridge fees and minimums. The estimator compares both routes for your amount.' },
    { q: 'Does splitting my XEN across wallets help?', a: 'Under the current rules, no: scores and drop chances are linear, so splitting changes nothing except your gas bill.' },
    { q: 'My XEN is on an exchange that is delisting it. What do I do?', a: 'Withdraw it to a wallet you control before the deadline. Then decide: hold, sell, or burn it here if its chain is supported.' },
    { q: 'When and how am I paid?', a: 'After the weekly epoch is published. The public keeper may submit the claim for you (its runs are irregular); otherwise claim on Missions within 90 days, or the amount goes back to the pool for everyone.' },
    { q: 'Is the Genesis airdrop real? Where do I claim it?', a: `Yes, for the 444 X1 validator withdraw authorities published on-chain on 2026-10-12: up to 120 Lunar Dust. ${INTERIM.genesisClaimPaused ? 'The claim is paused on this site until the final program upgrade (the claim button on /artifacts/ is disabled). ' : ''}${NEUTRAL.genesisDeadline} The only Genesis claim is this site’s /artifacts/ page. Any other "claim" link, message or form is not ours.` },
    { q: 'Can AI agents play?', a: 'Yes, with their own keypair, like anyone, and only for an operator who is 18 or older (or the legal age for games of chance) where such games are legal; the stake can be lost. The games are on-chain instructions. In Moon Wars every move is checked by the program; the creator currently has an edge (known issue GAM-4), and real-XNT matches are paused on the site at the moment (the program still accepts them). The agent kit on GitHub has a skill file, a JavaScript client and examples. Part of every pot goes to the burners’ pool.' },
    { q: 'Where do I ask for help?', a: 'X @MoonXenForge or an issue on GitHub. Nobody from Moon Forge will contact you first, and no chat group is official.' },
];

export interface KeyQaFact extends FaqFact { /** shown in the Start page's short block (6–8 entries) */ start?: boolean }

/**
 * The key questions, answered directly (docs/HOW-IT-WORKS.md is the long form). Every sentence about the final upgrade or the
 * v3 rules carries its planned date (WORDING §1); the rest is true today. Rendered in llms.txt, llms-full.txt, /faq/ and the
 * FAQPage JSON-LD; the entries marked `start` also on the Start page (React and static). No question repeats one of `faq`.
 */
export const keyQa: readonly KeyQaFact[] = [
    {
        start: true, q: 'What is Moon Forge, in one sentence?',
        a: `You burn XEN on Base, Optimism, Polygon, BSC or Avalanche through XEN’s own burn() and receive XNT on X1 from a public reward pool, valued by one public market rule, with no new token. ${SCALE_SHORT} It is one more way for XEN holders, alongside the others in the XEN and X1 ecosystem; holders can use several with different parts of their XEN.`,
    },
    {
        start: true, q: 'Is there a Moon Forge token or airdrop? What do I need?',
        a: 'No token, no token airdrop, no presale and no team allocation: only XEN, which you burn, and XNT, X1’s native coin, which you receive. The only airdrop is the Genesis airdrop: up to 120 Lunar Dust NFTs with no floor for the X1 validator withdraw authorities published on 2026-10-12 (claims through 2026-12-31 under the live program, through 2027-03-31 from the final upgrade planned 2026-11-18). To burn you need XEN in your own wallet on one of the five chains, a little gas on that chain, and an X1 address; you need no XNT to receive. Artifacts are optional NFTs bought with XNT.',
    },
    {
        start: true, q: 'Which XEN counts? Do old burns or Ethereum XEN count?',
        a: `Fresh burns only: the chain’s own XEN, held in your own wallet, burned through the Moon Forge portal ${identity.portal} on Base (8453), Optimism (10), Polygon (137), BNB Chain (56) or Avalanche (43114), each one recorded in XEN’s own burn ledger (userBurns) for your address. XEN on an exchange, in a stake or a XENFT, or wrapped or bridged does not count until it is liquid XEN in your wallet on one of those chains. Ethereum XEN: no. Moon Forge has no portal on Ethereum or PulseChain and none is planned by this project; Ethereum XEN already has its own path in the XEN ecosystem. Old burns: not paid here. The planned Legacy Pilot (FAQ) adds a one-time top-up only to a new burn made on one of the five chains from the same EVM address.`,
    },
    {
        start: true, q: 'Where does the XNT come from?',
        a: 'From one program account on X1, the reward pool, filled by Artifact forges (40% of the price today, 20% from the final upgrade planned 2026-11-18), house-game stakes (1%), player-versus-player and Predictions pots when someone wins (1% today, 1.5% from the final upgrade), Artifact market sales (2%, from the final upgrade), early-exit penalties, bonds and donations; the first funding came from the project’s own launch funding. On 2026-11-02 it held about 6.5 XNT; the Start and Transparency pages show the live figure. The program cannot create XNT, and no instruction lets anyone withdraw the pool; until the freeze, the upgrade key could still replace the program’s code. Moon Forge never buys XNT or XEN on the market.',
    },
    {
        q: 'How much XNT does a burn receive?',
        a: `No amount is promised, and a whole week is small: ${SCALE_WEEK} Today (rules 2) each burn receives a share of that weekly budget in proportion to its liquidity-adjusted value, at most 1.25× that value (Orbit 2× and Moon Landing 3× that), at one XNT price for the whole epoch; a tenth of each budget is drawn at random as Forge Drops. From the first epoch under the v3 rules (planned 2026-11-22) a burn is priced at its chain’s XEN price in its hour (the lowest of the 24-hour median, the last hourly close and 1.25× the chain’s reference), counted at about what selling it into that chain’s market would bring, and converted at that hour’s XNT price; Launchpad receives 1.25× that counted value in XNT at the claim, Orbit 2.5× released over 45 days, Moon Landing 3.75× released over 180 days, only while the week’s capacity lasts. Before you sign, the site shows the part that fits today’s capacity next to what selling would bring.`,
    },
    {
        start: true, q: 'Is it fair to someone burning 20 billion XEN when others burn trillions?',
        a: 'Every burn is valued by the same published rule, whatever the wallet or the chain, and splitting across wallets gains nothing. Under the v3 rules (planned from 2026-11-22) each chain’s liquidity curve counts a small burn at almost its full market value and a huge one at much less: on a market $2,000 deep, 20 billion XEN worth $50 counts $48.78, while 2 trillion XEN worth $5,000 counts $1,428.57 (100× the XEN, about 29× the counted value). These are illustrative numbers: on 2026-11-02 a whole week could pay all burners together only about 0.5 XNT. Capacity opens in daily slices, so a giant early burn takes only the slice open when it arrives. The limits: scripts can burn the moment a day’s slice opens, and if the day is full your burn waits for the week’s leftover, which may be nothing; burns on the same chain in the same hour share that hour’s value; a large burn lowers what later burns on the same chain count for, halving every 14 days; wallets the published rules list as the operator’s are paid after everyone else. Today (rules 2) every share is pro rata to value, and a large burn on your chain in the same week lowers the value of every burn on that chain.',
    },
    {
        q: 'What happens when many people burn?',
        a: 'Under the v3 rules (planned from 2026-11-22) a week pays at most 8% of the free reward pool (about 0.5 XNT on 2026-11-02), never more than seven times 2% of the XDEX pool’s XNT reserve, opened in seven daily slices counted from the previous publication, first come, first served. What does not fit at arrival is paid only from the week’s leftover (the Launchpad part only), which is not promised; what is still unpaid is not carried to a later week. There is no deadline: capacity nobody uses stays in the pool for later weeks. The program never lets a week’s budget, with the oracle’s allowance, go above 10% of the free pool. Today (rules 2) every burner is cut pro rata when that 10% limit binds.',
    },
    {
        q: 'When am I paid?',
        a: 'Weekly: each payout round (an epoch) comes at least 6 days after the previous one, scheduled for Sunday 00:00 UTC and often later. Today claims open as soon as an epoch is published. From the final upgrade (planned 2026-11-18) claims open 48 hours after publication, so that anyone can check the epoch and cancel (void) a wrong one by paying a bond, and they stay open 90 days; under the v3 rules the project’s keeper (a public bot that anyone can also run) usually claims every payout for its burner, even very small ones. Expect about 2 to 9 days from a burn to a Launchpad payout; Orbit and Moon Landing then release over 45 or 180 days from the claim.',
    },
    {
        q: 'Do I receive more or less with an Artifact?',
        a: 'An Artifact is an optional purchase, not a source of income: half of its price is spent the day you forge it, and the other half stays in it as a floor you take back by recycling. Today (rules 2) a held Artifact raises its holder’s share of an epoch by 5% to 50% inside the same budget. From the first epoch under the v3 rules (planned 2026-11-22) an Artifact never changes what the reward pool pays for a burn: a holder and a non-holder are paid the same. A forged Artifact can add a weekly rebate from a separate extra pot, filled only by 25% of forge prices (it does not exist before the upgrade), and only for the holder’s own burns that the reward pool did not fully pay: at most 2% of the price paid per Artifact per week, for 52 weeks, while the pot lasts; a holder who does not burn receives nothing from it. As a group, forgers can get back at most 75% of what they pay (the 50% floors plus at most the 25% extra pot): 20% goes to all burners and 5% to the architect.',
    },
    {
        start: true, q: 'I only want to play. Can I try to win XNT with games?',
        a: 'Only if you are 18 or older (or the legal age for games of chance where you live) and such games are legal where you are. You play with XNT only and can lose the whole stake. House games (Coin Flip, High-Low, Void Rush) have a built-in edge: on average 97 to 98 XNT come back per 100 staked, depending on the game and the target. Today the site offers house games, the Jackpot and the Burn Lottery (settle your own house bet within about 3 minutes); a Duel needs an Artifact and forging is paused on the site; real-XNT Moon Wars is paused (free practice open). From the final upgrade (planned 2026-11-18) the site offers sealed Duels and Moon Wars with no Artifact needed (2% of the pot only when someone wins; draws refunded), and shows house games and the Jackpot only while the chain shows a live house keeper; none is scheduled, so they may stay hidden. The Burn Lottery then takes no new entries.',
    },
    {
        start: true, q: 'Who controls Moon Forge?',
        a: 'The burn portals have no owner and cannot be changed. The X1 program can still be upgraded by one key held by the anonymous builder, who leaves after the freeze; until then that key could replace the code, including code that moves the pools. The freeze (burning that key) is planned for 2026-12-02 at the earliest and 2026-12-31 at the latest. After it, no key can change a rule, fee or split, pause the program or withdraw the pools; XNT leaves them only by the program’s own rules. What remains, from the final upgrade (planned 2026-11-18): an oracle seat that publishes the weekly epochs within on-chain limits (at most 10% of the free pool, at least 6 days apart, cancellable by anyone with a bond during a 48-hour hold), a cold key that can replace a stolen hot key, a house keeper once someone arms one, and an architect payee that can only move or renounce its own address. The architect payee receives nothing from burns, claims or the pools; the pool pays small running costs (the oracle’s allowance and keeper tips) to the keys that run the oracle and the keeper.',
    },
    {
        q: 'How can the community take it over and run it?',
        a: 'Today anyone can run the keeper (npm run keeper in the oracle folder, with a funded X1 key), recompute every epoch (npm run verify -- epoch-N.json --full), host the site (MIT license) and mirror the epoch files, which the agent kit checks against the data stored on X1; publishing an epoch still needs the oracle key. From the final upgrade (planned 2026-11-18) anyone can cancel (void) a wrong epoch during its 48-hour hold by paying a bond into the pool (10% of its budget, at least 0.05 XNT); if no epoch survives its hold for 28 days, the largest voider can take the oracle seat from day 28 and anyone from day 29, with a bond of 10% of the free pool (at least 1 XNT), and keep publishing on the same pools with the same code. From 2026-12-16 anyone can create a house-keeper seat that was never created, with a bond of at least 20 XNT (npm run keeper-arm), and anyone can take a keeper seat idle for 28 days, with nothing pending and the same bond (npm run keeper-take). Nobody can veto either.',
    },
    {
        start: true, q: 'Is it a scam? How can I check?',
        a: `Check it yourself: the source is public (MIT); the X1 explorer shows who can still upgrade the program (${identity.x1Explorer}/address/${identity.programId}); the deployed bytes can be rebuilt and their hash compared; the portals are verified on Sourcify; every weekly epoch can be recomputed with npm run verify; counter.json lists the XEN removed from supply and the XNT set aside. There is no token, no presale and no fee on the burn path, and no instruction lets anyone withdraw the pools. What you still trust: no third-party audit (internal reviews only), a bounded oracle, the upgrade key until the freeze, and GitHub for the automation. Moon Forge never messages anyone first and never asks anyone to sign or pay to claim old burns or the Legacy Pilot.`,
    },
    {
        q: 'What are the risks?',
        a: 'A burn cannot be undone. The pool is small (about 6.5 XNT on 2026-11-02), so payouts are small; a payout can be less than selling, late, or nothing if no epoch is published; XNT is volatile and thin. Scripts can take a day’s capacity first. There is no third-party audit; bugs cannot be fixed after the freeze, and the builder leaves then. The oracle is bounded but trusted: a wrong epoch that nobody cancels within 48 hours is paid, and an honest epoch that someone cancels by paying a bond is not paid later. The reward rules are oracle policy: after the switch to the v3 rules (announced at least one full epoch ahead), any later change needs a new rule set announced at least two epochs ahead, never applied backwards. Artifact floors depend on Metaplex Core, and the whole program on X1’s runtime. Games can lose the whole stake. Taxes are your own responsibility. If the GitHub account falls, the site, the oracle, the keeper and the epoch files stop; payouts pause; the pools stay locked in the program.',
    },
    {
        q: 'Is Moon Forge part of another XEN or X1 project, or of X1 Forge?',
        a: 'No. Moon Forge is independent and open source, run by one anonymous builder who receives the disclosed cuts. It is separate from X1 Labs, the XEN team and every other XEN or X1 project, and it is not an official XNT allocation; each project has its own rules, and none speaks for the others. Moon Forge and X1 Forge are separate projects with similar names.',
    },
    {
        q: 'Does burning raise the price of XEN or XNT?',
        a: 'Each burn permanently removes that XEN from its chain’s supply, and XEN records it in its own burn ledger. Moon Forge makes no claim about the price of XEN or XNT: prices depend on demand, and new XEN can still be minted. Moon Forge does not buy XEN or XNT on the market.',
    },
];
/** The Start page's short block (React and static): the entries marked `start`. */
export const startQa: readonly KeyQaFact[] = keyQa.filter((k) => k.start);

/** Whitepaper v2 summary (the full text is docs/WHITEPAPER.md in the repository). */
export const whitepaper: readonly { title: string; paragraphs: readonly string[] }[] = [
    { title: 'Problem', paragraphs: [
        `XEN lives on many EVM chains; X1 is an SVM chain whose token is XNT. Reaching XNT through the market means selling XEN, moving USD to X1 and buying through thin pools, which is expensive for small holders. Moon Forge offers one more path, for XEN on the side chains (${liveChainNames.join(', ')}): burn XEN where it lives, receive XNT on X1. Ethereum XEN already has its own path in the XEN ecosystem; Ethereum and PulseChain have no Moon Forge portal and none is planned by this project.`,
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
        'Forge Drops: 10% of the epoch budget, capped at 100 XNT (20 × 5 XNT), is part of the budget (not extra) and is drawn as Lunar Dust whose floor is the drop value (≥ 5 XNT). Chance = expected drop value ÷ 5 XNT; at or above 5 XNT the whole value becomes the floor. A random draw: 18+ and only where such draws are legal. The seed is the hash of the first block at or after the publish slot + 4; if nobody seals within ~512 slots the drops are cancelled and the reserve goes back to the pool.',
        'Inflows: donations, 1% of house-game stakes, 1% of P2P pots and lottery tickets, 40% of Artifact forges, eject penalties, unclaimed or expired epoch budgets, cancelled Forge Drops, expired lottery prizes, orphan-Artifact floors, and the architect’s cut while its wallet is below rent exemption. Outflows: epoch claims, Forge Drops and keeper tips.',
        'No token, no inflation, no promised payout. If nobody funds the pool, burns pay nothing; the live pool is shown before you burn.',
    ] },
    { title: 'Games and fairness', paragraphs: [
        ageNotice, gameRules.randomness, gameRules.settlement,
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
    { path: '/', title: `Moon Forge | ${identity.tagline}`, description: identity.description, index: true },
    { path: '/start/', title: 'Start here | Moon Forge', description: 'What Moon Forge can really pay this week, how to burn XEN for XNT step by step, how to verify it yourself, the risks, and the questions people ask.', index: true },
    { path: '/faq/', title: 'FAQ | Moon Forge', description: 'Questions people ask about Moon Forge: where the XNT comes from, which XEN counts, old burns, fairness, games, who controls it, how to check it, minimums, payouts, the Genesis airdrop and AI agents.', index: true },
    { path: '/forge/', title: 'The Forge | Moon Forge', description: `Burn XEN on ${liveChainNames.join(', ')} through the Moon Forge portal and receive XNT on X1. Zero protocol fee on the burn path.`, index: true, app: true },
    { path: '/missions/', title: 'Missions | Moon Forge', description: 'Claim your weekly XNT, follow vesting and withdraw vested XNT.', index: true, app: true },
    { path: '/artifacts/', title: 'Artifacts | Moon Forge', description: 'Metaplex Core NFTs minted by the Moon Forge program: floor you can take back, burn boost, weekly chips and arena ticket.', index: true },
    { path: '/nft/', title: 'Artifacts | Moon Forge', description: 'Moon Forge Artifacts (alias of /artifacts/).', index: false, canonical: '/artifacts/' },
    { path: '/marketplace/', title: 'Artifacts | Moon Forge', description: 'Moon Forge runs no marketplace; Artifacts live at /artifacts/.', index: false, canonical: '/artifacts/' },
    { path: '/games/', title: 'Games | Moon Forge', description: 'On-chain XNT games of the Moon Forge program, 18+ only and only where legal: house games with a fixed 2% edge, Jackpot, Artifact Duel, Moon Wars, Burn Lottery and Be the House. You can lose the whole stake.', index: true },
    { path: '/donate/', title: 'Donate | Moon Forge', description: 'A donation goes to the reward pool, which pays XEN burners through the weekly budget and small running costs (keeper tips). The architect receives nothing from it.', index: true, app: true },
    { path: '/transparency/', title: 'Transparency | Moon Forge', description: 'Program and upgrade authority, live configuration, vaults, lifetime counters, who can do what, every fee and split, key constants and epochs.', index: true },
    { path: '/whitepaper/', title: 'Whitepaper v2 | Moon Forge', description: 'Problem, flow, scoring and payout, budget rules, games and fairness, Artifacts, fees, trust assumptions and risks of Moon Forge v2.', index: true },
];

/** Extra sitemap entries (files, not routes). Relative to SITE_URL. */
export const sitemapFiles: readonly string[] = ['llms.txt', 'llms-full.txt', 'agent-card.json', 'epochs/index.json', 'counter.json'];

export const facts = {
    INTERIM, rules, identity, officialLinks, chains, liveChains, epochRules, tiers, fees, artifacts, forgeSplit, artifactRules,
    games, gameRules, notices, disambiguation, position, scale, SCALE_DATE, oldBurns, ageNotice, legacyPilot, quoteFeed, never, notOfficial, xNote, verify, risks, trust, verifyChecklist, steps,
    faq, keyQa, startQa, whitepaper, routes, sitemapFiles,
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
