/**
 * Start here — a plain-language guide for first-time users, with the numbers that matter read live:
 * what this week can really pay, how to burn step by step, what to verify before trusting anything,
 * the risks, and answers to the questions people actually ask.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, AlertTriangle, XCircle, ShieldCheck, Compass } from 'lucide-react';
import { usePoll, useNow, useProtocol } from '../lib/hooks';
import { ARCHITECT, fetchUpgradeAuthority, FORGE_SPLIT, P, PDA, PROGRAM_ID, explorerAddress, toXnt } from '../lib/protocol';
import { CHAINS, EVM_CHAINS, isPortalDeployed, PROJECT_LINKS, formatDuration } from '../lib/constants';
import { fetchXntUsd } from '../components/ROICalculator';
import { useChainMarkets, weekCapacity } from '../lib/market';
import { money } from '../components/FairValueEngine';
import { AddrLink, Notice, Xnt } from '../components/ui';

const WEEK = 7 * 86_400;
const SUNDAY_0 = 3 * 86_400; // 1970-01-04 00:00 UTC
const PORTAL = '0x7b00f314aB48D223bee567181CA89c65126Bf6E9';
const usd = (v: number) => (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`);

function Check({ state, title, children }: { state: 'ok' | 'warn' | 'no'; title: string; children: React.ReactNode }) {
    const Icon = state === 'ok' ? CheckCircle2 : state === 'warn' ? AlertTriangle : XCircle;
    const color = state === 'ok' ? 'text-green-400' : state === 'warn' ? 'text-yellow-400' : 'text-red-400';
    return (
        <div className="flex gap-3 py-3 border-b border-white/5 last:border-0">
            <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${color}`} />
            <div className="text-sm"><div className="text-white mb-0.5">{title}</div><div className="text-lunar-400">{children}</div></div>
        </div>
    );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
    return (
        <li className="flex gap-4">
            <span className="w-8 h-8 shrink-0 rounded-full bg-forge-orange/15 text-forge-orange font-space flex items-center justify-center">{n}</span>
            <div className="text-sm text-lunar-300 pt-1"><div className="text-white font-medium mb-1">{title}</div>{children}</div>
        </li>
    );
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
    return (
        <details className="group border-b border-white/5 py-3">
            <summary className="cursor-pointer text-white text-sm list-none flex justify-between gap-4">
                <span>{q}</span><span className="text-lunar-500 group-open:rotate-45 transition-transform">+</span>
            </summary>
            <div className="text-sm text-lunar-400 mt-2 leading-relaxed">{children}</div>
        </details>
    );
}

export default function StartPage() {
    const proto = useProtocol(60_000);
    const upg = usePoll(() => fetchUpgradeAuthority(), [], 300_000);
    const now = useNow(30_000);
    const [xntUsd, setXntUsd] = useState<number | null>(null);
    useEffect(() => { fetchXntUsd().then(setXntUsd).catch(() => setXntUsd(null)); }, []);

    const d = proto.data;
    const budget = d ? toXnt(d.nextEpochBudget) : null;
    const drops = d ? toXnt(d.nextDropReserve) : null;
    const nextEpoch = now - ((now - SUNDAY_0) % WEEK) + WEEK;
    const live = EVM_CHAINS.filter((k) => isPortalDeployed(k)).map((k) => CHAINS[k]);
    const soon = EVM_CHAINS.filter((k) => !isPortalDeployed(k)).map((k) => CHAINS[k].name);
    const authority = upg.data?.authority ?? null;
    const smallPool = budget !== null && budget < 5;
    const stats = d?.config?.stats;
    const markets = useChainMarkets();
    const cap = weekCapacity(markets.rows, budget, xntUsd, P.rateCapK);

    return (
        <div className="max-w-4xl mx-auto space-y-10">
            <header className="text-center space-y-3">
                <h1 className="font-space text-4xl font-bold"><Compass className="inline w-8 h-8 text-forge-orange mr-2" />Start here</h1>
                <p className="text-lunar-300 max-w-2xl mx-auto">
                    Moon Forge burns XEN that is hard to sell and pays XNT on X1. Every rule is public, every payout can be recomputed,
                    and nothing here asks you to trust anyone. This page shows what it can really pay this week, how to use it, and how to check it yourself.
                </p>
                <p className="text-xs text-lunar-500">An independent community project. Not run by the XEN or X1 teams, not XEN Prime, and not X1 Forge.</p>
            </header>

            {/* ── this week, in real numbers ── */}
            <section className="glass-card space-y-4">
                <h2 className="font-space text-xl">This week, in real numbers</h2>
                <div className="grid sm:grid-cols-3 gap-4 text-sm">
                    <div className="bg-space-700/40 rounded-xl p-4">
                        <div className="text-lunar-400 text-xs mb-1">Most this epoch can pay, to everyone together</div>
                        <div className="font-mono text-2xl text-white">{budget !== null ? <Xnt lamports={d!.nextEpochBudget} digits={2} /> : '--'}</div>
                        <div className="text-lunar-500 text-xs">{budget !== null && xntUsd ? `≈ ${usd(budget * xntUsd)} at today's XNT price` : '10% of the free reward pool'}</div>
                    </div>
                    <div className="bg-space-700/40 rounded-xl p-4">
                        <div className="text-lunar-400 text-xs mb-1">Part of it drawn as Forge Drops</div>
                        <div className="font-mono text-2xl text-white">{drops !== null ? <Xnt lamports={d!.nextDropReserve} digits={3} /> : '--'}</div>
                        <div className="text-lunar-500 text-xs">Lunar Dust NFTs worth ≥ {P.dropBackingXnt} XNT each</div>
                    </div>
                    <div className="bg-space-700/40 rounded-xl p-4">
                        <div className="text-lunar-400 text-xs mb-1">Next epoch is built</div>
                        <div className="font-mono text-2xl text-white">{formatDuration(Math.max(0, nextEpoch - now))}</div>
                        <div className="text-lunar-500 text-xs">Sundays 00:00 UTC · XNT {xntUsd ? usd(xntUsd) : '--'}</div>
                    </div>
                </div>
                {smallPool && (
                    <Notice kind="warn">
                        The reward pool is small right now. The whole epoch pays at most {budget!.toFixed(2)} XNT{xntUsd ? ` (≈ ${usd(budget! * xntUsd)})` : ''} to all burners together,
                        however much is burned. Burning today makes sense only if that is worth more to you than your XEN, or to support the project.
                        The pool grows from donations, game edges and Artifact sales; this number updates live.
                    </Notice>
                )}
                {cap && (
                    <p className="text-sm text-lunar-300">
                        <strong className="text-white">Fair capacity left this week: {money(cap.remainingUsd)}</strong> of counted value. Within it, a burn should pay at least what selling
                        that XEN would return (the liquidity discount is the same math as selling into the pool); beyond it, burns are paid pro-rata and likely earn less.
                        The Forge checks your burn against it before you sign.
                    </p>
                )}
                <p className="text-xs text-lunar-500">
                    Why so careful: an epoch pays at most {P.epochBudgetBps / 100}% of the free reward pool and at most {P.rateCapK}× the liquidity-adjusted value burned (×2 Orbit, ×3 Moon Landing).
                    That keeps the pool from ever being emptied, and it means nobody can promise you a return. We don't.
                </p>
            </section>

            {/* ── is it for me ── */}
            <section className="grid md:grid-cols-3 gap-4">
                <div className="glass-card text-sm">
                    <div className="text-white font-medium mb-2">Your XEN is on a side chain</div>
                    <p className="text-lunar-400">Portals are live on {live.map((c) => c.name).join(', ')}{soon.length ? `; ${soon.join(' and ')} follow` : ''}. XEN Prime is announced for Ethereum XEN only, and side-chain pools are thin. Each chain's XEN is valued at its own market price.</p>
                </div>
                <div className="glass-card text-sm">
                    <div className="text-white font-medium mb-2">You hold a small amount</div>
                    <p className="text-lunar-400">Your share is linear in value: no bonus for whales, nothing gained by splitting wallets. Forge Drops give every burner a chance at a {P.dropBackingXnt} XNT Lunar Dust, in proportion to what they burned.</p>
                </div>
                <div className="glass-card text-sm">
                    <div className="text-white font-medium mb-2">You want to check first</div>
                    <p className="text-lunar-400">Good. Read the checklist below, look at the contracts yourself, and burn a tiny amount first if you want to see the whole flow before committing more.</p>
                </div>
            </section>

            {/* ── every path feeds the others ── */}
            <section className="glass-card space-y-4">
                <h2 className="font-space text-xl">Pick your path: every one feeds the others</h2>
                <p className="text-sm text-lunar-400">
                    The reward pool that pays burners is filled by everything else people do here, and what burners receive can flow back into the rest.
                    Nobody has to do everything: use the part that suits you.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2 text-xs font-mono text-lunar-300 bg-space-700/40 rounded-xl p-3">
                    <span className="px-2 py-1 rounded bg-space-600">games · Artifacts · penalties · donations</span><span>→</span>
                    <span className="px-2 py-1 rounded bg-forge-orange/20 text-forge-orange">reward pool</span><span>→</span>
                    <span className="px-2 py-1 rounded bg-space-600">weekly budget (≤ {P.epochBudgetBps / 100}%)</span><span>→</span>
                    <span className="px-2 py-1 rounded bg-space-600">XEN burners</span><span>→</span>
                    <span className="px-2 py-1 rounded bg-space-600">XNT to play, forge, back the house</span>
                </div>
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
                    <div className="bg-space-700/40 rounded-xl p-4">
                        <div className="text-white font-medium mb-1">I hold XEN</div>
                        <p className="text-lunar-400 mb-2">Burn it for XNT, valued at its own chain's market. No fee on this path. Best when the week's fair capacity is open (shown on The Forge).</p>
                        <Link className="text-forge-orange hover:underline" to="/forge">The Forge →</Link>
                    </div>
                    <div className="bg-space-700/40 rounded-xl p-4">
                        <div className="text-white font-medium mb-1">I hold XNT and want to play</div>
                        <p className="text-lunar-400 mb-2">House games and player-vs-player games. {P.edgeToPoolPct}% of every house stake and {P.rakeToPoolPct}% of every P2P pot go to the burners' pool. Lost XNT? If you hold XEN, burning it is a way to earn XNT back.</p>
                        <Link className="text-forge-orange hover:underline" to="/games">Games →</Link>
                    </div>
                    <div className="bg-space-700/40 rounded-xl p-4">
                        <div className="text-white font-medium mb-1">I want to back the house</div>
                        <p className="text-lunar-400 mb-2">Deposit XNT into the game bankroll and share its result: {P.edgeToBankrollPct}% of every house stake stays in it, and it pays the winners. A bigger bankroll allows bigger bets. Withdraw with a {P.houseWithdrawHours} h cooldown; you can lose.</p>
                        <Link className="text-forge-orange hover:underline" to="/games">Be the House →</Link>
                    </div>
                    <div className="bg-space-700/40 rounded-xl p-4">
                        <div className="text-white font-medium mb-1">I want an Artifact</div>
                        <p className="text-lunar-400 mb-2">{FORGE_SPLIT.floorPct}% of the price stays inside the NFT as a floor you can take back, {FORGE_SPLIT.poolPct}% goes to the burners' pool. It boosts your burn share, earns weekly lottery chips and is your arena ticket. Recycle it any time to take the floor back: the slot is forged again at the new price, and another {FORGE_SPLIT.poolPct}% flows into the pool.</p>
                        <Link className="text-forge-orange hover:underline" to="/artifacts">Artifacts →</Link>
                    </div>
                    <div className="bg-space-700/40 rounded-xl p-4">
                        <div className="text-white font-medium mb-1">I just want to help</div>
                        <p className="text-lunar-400 mb-2">A donation to the reward pool goes 100% to burners, through the weekly budget. Nothing is taken on the way.</p>
                        <Link className="text-forge-orange hover:underline" to="/donate">Donate →</Link>
                    </div>
                    <div className="bg-space-700/40 rounded-xl p-4">
                        <div className="text-white font-medium mb-1">Where the pool's XNT came from</div>
                        <ul className="text-lunar-400 space-y-0.5">
                            <li>Games: {stats ? <Xnt lamports={Number(stats.edgeToPool)} digits={3} /> : '--'}</li>
                            <li>Artifacts: {stats ? <Xnt lamports={Number(stats.artifactToPool)} digits={3} /> : '--'}</li>
                            <li>Early-exit penalties: {stats ? <Xnt lamports={Number(stats.penaltiesToPool)} digits={3} /> : '--'}</li>
                            <li>Donations: {stats ? <Xnt lamports={Number(stats.donatedReward)} digits={3} /> : '--'}</li>
                        </ul>
                        <p className="text-xs text-lunar-500 mt-1">On-chain counters, read live.</p>
                    </div>
                </div>
            </section>

            {/* ── step by step ── */}
            <section className="glass-card space-y-5">
                <h2 className="font-space text-xl">How to do it, step by step</h2>
                <ol className="space-y-5">
                    <Step n={1} title="Get an X1 wallet">
                        On desktop, install the <a className="text-forge-orange hover:underline" href={PROJECT_LINKS.x1Wallet} target="_blank" rel="noopener noreferrer">X1 Wallet</a> extension.
                        On mobile, use Backpack with the custom RPC <code className="text-xs">https://rpc.mainnet.x1.xyz</code>. MetaMask does not support X1. Copy your X1 address: it is where your XNT will arrive.
                    </Step>
                    <Step n={2} title="Have your XEN in a wallet you control">
                        XEN sitting on an exchange cannot be burned: withdraw it first to an EVM wallet (MetaMask, Rabby, Trust…) on a supported chain, plus a few cents of that chain's gas token.
                    </Step>
                    <Step n={3} title={'Open The Forge, connect, and paste your X1 address'}>
                        Choose the amount and a tier: <strong className="text-white">Launchpad</strong> pays at claim (1×), <strong className="text-white">Orbit</strong> vests over 45 days (2×),
                        <strong className="text-white"> Moon Landing</strong> over 180 days (3×). Leaving early from a vesting tier costs {P.tiers[1].penaltyPct}% / {P.tiers[2].penaltyPct}% of the unvested part, so pick the one you will keep.
                    </Step>
                    <Step n={4} title="Confirm two transactions">
                        First an approval for exactly the amount you burn (never unlimited), then the burn. The portal calls XEN's own <code className="text-xs">burn()</code>: the supply really goes down.
                        Your only cost is gas on that chain. Moon Forge takes no fee on this path.
                    </Step>
                    <Step n={5} title="Wait for the Sunday epoch">
                        The oracle values every burn of the week at its chain's market price and publishes the result on X1, with the full data file anyone can recompute.
                    </Step>
                    <Step n={6} title="Receive XNT">
                        The public keeper usually submits your claim for you; you can also claim on <Link className="text-forge-orange hover:underline" to="/missions">Missions</Link>.
                        Launchpad XNT lands in your X1 wallet; for Orbit and Moon Landing use "Withdraw vested" as it unlocks. Claim within {P.claimWindowDays} days.
                    </Step>
                </ol>
                <div className="flex flex-wrap gap-3 pt-2">
                    <Link to="/forge" className="btn-forge">Open The Forge</Link>
                    <Link to="/forge" className="btn-outline">Estimate a burn first</Link>
                </div>
            </section>

            {/* ── verify it yourself ── */}
            <section className="glass-card">
                <h2 className="font-space text-xl mb-1"><ShieldCheck className="inline w-5 h-5 text-green-400 mr-2" />Verify it yourself</h2>
                <p className="text-sm text-lunar-400 mb-3">Each line links to a source you can check without us. Yellow and red lines are the honest limits.</p>
                <Check state="ok" title="Burn portals have no owner, no fee, no pause and no upgrade">
                    Same address on every chain (<code className="text-xs break-all">{PORTAL}</code>), source verified as an exact match on Sourcify:{' '}
                    {live.map((c, i) => (
                        <span key={c.key}>{i > 0 && ' · '}<a className="text-forge-orange hover:underline" href={`https://repo.sourcify.dev/${c.chainId}/${PORTAL}`} target="_blank" rel="noopener noreferrer">{c.name}</a></span>
                    ))}.
                </Check>
                <Check state="ok" title="Zero fee on the burn path">
                    Burn, claim, vesting and Forge Drops pay nothing to anyone. The architect earns only from games and Artifact sales; every split is on the{' '}
                    <Link className="text-forge-orange hover:underline" to="/transparency">Transparency</Link> page and in <a className="text-forge-orange hover:underline" href={PROJECT_LINKS.programConstants} target="_blank" rel="noopener noreferrer">constants.rs</a>.
                </Check>
                <Check state="ok" title="The money is where the site says it is">
                    Reward pool <AddrLink address={PDA.rewardVault()} /> holds {d ? <Xnt lamports={d.rewardTotal} digits={2} /> : '--'}; game bankroll <AddrLink address={PDA.bankrollVault()} /> holds{' '}
                    {d ? <Xnt lamports={d.bankrollFree + d.bankrollReserved} digits={2} /> : '--'}. Read live from X1 right now.
                </Check>
                <Check state="ok" title="Every payout can be recomputed">
                    Each epoch file (burns, prices, liquidity, every leaf) is public and hash-committed on-chain. Anyone can run{' '}
                    <code className="text-xs">cd oracle && npm run verify -- epoch-N.json --full</code> from the <a className="text-forge-orange hover:underline" href={PROJECT_LINKS.github} target="_blank" rel="noopener noreferrer">open source</a> and get the same result.
                </Check>
                <Check state="ok" title="No token, no presale, no team allocation">
                    There is nothing to buy from us. The program can only pay what is in its vaults, within the limits above.
                </Check>
                <Check state={authority ? 'warn' : 'ok'} title={authority ? 'The program can still be upgraded (test period)' : 'The program can no longer be upgraded'}>
                    {authority
                        ? <>Upgrade authority: <AddrLink address={authority} />{authority.equals(ARCHITECT) ? ' (the architect wallet)' : ''}. It will be burned after the public test period, and this line will turn green on its own. Program <a className="text-forge-orange hover:underline" href={explorerAddress(PROGRAM_ID)} target="_blank" rel="noopener noreferrer">on the explorer</a>.</>
                        : upg.data ? 'The upgrade authority has been burned: the code on-chain is final.' : 'Reading the program account…'}
                </Check>
                <Check state="no" title="No third-party audit yet">
                    The internal reviews (not independent) and every finding are public in <a className="text-forge-orange hover:underline" href={`${PROJECT_LINKS.github}/blob/main/docs/AUDIT-2026-10.md`} target="_blank" rel="noopener noreferrer">AUDIT-2026-10.md</a>. Use amounts you can afford to lose.
                </Check>
            </section>

            {/* ── never ── */}
            <section className="grid md:grid-cols-2 gap-4">
                <div className="glass-card text-sm">
                    <h2 className="font-space text-lg mb-2">What Moon Forge will never do</h2>
                    <ul className="list-disc list-inside space-y-1 text-lunar-300">
                        <li>Message you first, or ask for a seed phrase or private key.</li>
                        <li>Sell you a token, a presale or a "whitelist".</li>
                        <li>Promise returns or price targets.</li>
                        <li>Rush you: there is no deadline and no prize for burning first.</li>
                    </ul>
                    <p className="text-xs text-lunar-500 mt-3">Official places only: this site, the GitHub repository and X <a className="text-forge-orange hover:underline" href="https://x.com/MoonXenForge" target="_blank" rel="noopener noreferrer">@MoonXenForge</a>.</p>
                </div>
                <div className="glass-card text-sm">
                    <h2 className="font-space text-lg mb-2">Risks, plainly</h2>
                    <ul className="list-disc list-inside space-y-1 text-lunar-300">
                        <li>Burned XEN is gone forever. There is no undo.</li>
                        <li>You are paid in XNT, and its price moves{xntUsd ? ` (today ${usd(xntUsd)})` : ''}.</li>
                        <li>What a week pays depends on the pool and on how much others burn.</li>
                        <li>Smart contracts can have bugs; there is no third-party audit.</li>
                    </ul>
                </div>
            </section>

            {/* ── FAQ ── */}
            <section className="glass-card">
                <h2 className="font-space text-xl mb-2">Questions people ask</h2>
                <Faq q="Is this XEN Prime? Is it run by the X1 team?">
                    No to both. Moon Forge is an independent, open-source project. XEN Prime is announced for Ethereum XEN only; Moon Forge works with XEN on
                    {' '}{live.map((c) => c.name).join(', ')}{soon.length ? ` (${soon.join(' and ')} follow)` : ''}. You can use both with different XEN.
                </Faq>
                <Faq q="Is this X1 Forge?">
                    No. X1 Forge ($FORGE) is a separate, unrelated project on X1. Moon Forge has no token at all: if you see a "Moon Forge" token, presale or
                    airdrop claim anywhere, it is not us. Official places: this site, the GitHub repository and the project's X account.
                </Faq>
                <Faq q="Can I calculate what I will get?">
                    Yes, after the fact, exactly: the epoch file lists every burn, its price and your share, and the program checks the totals. Before the epoch you can only
                    estimate, because your share depends on what others burn that week. The estimator on <Link className="text-forge-orange hover:underline" to="/forge">The Forge</Link> shows the
                    upper bound, and the <Link className="text-forge-orange hover:underline" to="/transparency">Transparency</Link> page shows, chain by chain, what the same burn is worth right now and why (Fair Value Engine).
                </Faq>
                <Faq q="What do I gain burning a little when others burn trillions?">
                    Exactly your share of the value: 1% of the week's value earns 1% of the budget, whatever the size. Small burners also enter the Forge Drops draw with a chance
                    equal to their expected drop value ÷ {P.dropBackingXnt} XNT.
                </Faq>
                <Faq q="Is there a minimum?">
                    Any amount above zero can be burned. A burn worth less than a millionth of a dollar after the liquidity discount scores zero, so in practice every real burn counts.
                </Faq>
                <Faq q="Why not just sell my XEN?">
                    You can, and sometimes that is better. On thin side-chain pools a sale loses a lot to slippage, and moving the dollars to X1 costs bridge fees and minimums.
                    The estimator compares both routes for your amount.
                </Faq>
                <Faq q="Does splitting my XEN across wallets help?">No. Scores and drop chances are linear, so splitting changes nothing except your gas bill.</Faq>
                <Faq q="My XEN is on an exchange that is delisting it. What do I do?">
                    Withdraw it to a wallet you control before the deadline. Then decide: hold, sell, or burn it here if its chain is supported.
                </Faq>
                <Faq q="When and how am I paid?">
                    After the Sunday epoch is published. The keeper usually submits the claim; otherwise claim on Missions within {P.claimWindowDays} days, or the amount returns to the pool for everyone.
                </Faq>
                <Faq q="Can AI agents play?">
                    Yes, with their own keypair, like anyone: the games are on-chain instructions. Moon Wars is perfect information and every move is checked by the program,
                    so a better policy wins. The <a className="text-forge-orange hover:underline" href={`${PROJECT_LINKS.github}/tree/main/agents`} target="_blank" rel="noopener noreferrer">agent kit</a> has
                    a skill file, a JavaScript client and examples. Part of every pot goes to the burners' pool.
                </Faq>
                <Faq q="Where do I ask for help?">
                    X <a className="text-forge-orange hover:underline" href="https://x.com/MoonXenForge" target="_blank" rel="noopener noreferrer">@MoonXenForge</a> or an issue on{' '}
                    <a className="text-forge-orange hover:underline" href={PROJECT_LINKS.github} target="_blank" rel="noopener noreferrer">GitHub</a>. Nobody from Moon Forge will contact you first.
                </Faq>
            </section>

            <p className="text-center text-xs text-lunar-500">Numbers on this page are read live from X1 and public price sources. Rules: <Link className="text-forge-orange hover:underline" to="/whitepaper">Whitepaper</Link>.</p>
        </div>
    );
}
