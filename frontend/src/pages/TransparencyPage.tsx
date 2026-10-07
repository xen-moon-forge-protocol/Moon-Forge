/**
 * Transparency — live reads of the Moon Forge program on X1 and the exact rules it enforces.
 * Nothing on this page is typed in by hand except the rule tables, which mirror
 * programs/moon-forge/src/{lib.rs,constants.rs} (links below).
 */
import { ShieldAlert, Eye, Database, FileCheck2, Users } from 'lucide-react';
import { usePoll, useProtocol } from '../lib/hooks';
import {
    ARCHITECT, ARTIFACTS, fetchEpochAccounts, fetchEpochIndex, fetchUpgradeAuthority, FORGE_SPLIT, P, PDA, PROGRAM_ID, explorerTx,
    SECONDARY_ROYALTY_PCT, AIRDROP_MAX,
} from '../lib/protocol';
import { formatNumber, PROJECT_LINKS } from '../lib/constants';
import { AddrLink, Notice, Row, Xnt } from '../components/ui';

const n = (x: any): number | null => (x === null || x === undefined ? null : Number(x.toString()));
const ts = (x: any) => (n(x) ? new Date(n(x)! * 1000).toLocaleString() : '--');

export default function TransparencyPage() {
    const proto = useProtocol(30_000);
    const upg = usePoll(() => fetchUpgradeAuthority(), [], 300_000);
    const index = usePoll(() => fetchEpochIndex(), [], 300_000);
    const cfg = proto.data?.config;
    const last = cfg ? Number(cfg.lastEpoch) : 0;
    const ids = Array.from({ length: Math.min(20, last) }, (_, i) => last - i).filter((x) => x >= 1);
    const epochs = usePoll(() => fetchEpochAccounts(ids), [last], 120_000);
    const stats = cfg?.stats;
    const authority = upg.data?.authority;
    // "No authority" is shown only when the ProgramData account was actually read; any failed or partial read shows "--".
    const noAuthority = !upg.error && !!upg.data && !authority && !!upg.data.programData && upg.data.lastDeploySlot !== null;

    return (
        <div className="max-w-6xl mx-auto space-y-8">
            <div className="text-center">
                <h1 className="font-space text-4xl font-bold mb-2"><Eye className="inline w-8 h-8 text-forge-gold mr-2" />Transparency</h1>
                <p className="text-lunar-400 max-w-3xl mx-auto">
                    Live state of the Moon Forge program on X1, the full list of who can do what, every fee, and how to verify each epoch yourself.
                </p>
            </div>

            {/* Program & upgrade authority */}
            <section className="glass-card">
                <div className="flex items-center gap-2 mb-4"><ShieldAlert className="w-5 h-5 text-amber-400" /><h2 className="font-space text-xl">Program and upgrade authority</h2></div>
                <div className="grid md:grid-cols-2 gap-x-8">
                    <Row label="Program id"><AddrLink address={PROGRAM_ID} full /></Row>
                    <Row label="ProgramData account">{upg.data?.programData ? <AddrLink address={upg.data.programData} /> : '--'}</Row>
                    <Row label="Upgrade authority">
                        {upg.error ? '--' : !upg.data ? '--' : authority
                            ? <><AddrLink address={authority} />{authority.equals(ARCHITECT) && <span className="text-amber-400 ml-1">(architect wallet)</span>}</>
                            : noAuthority ? <span className="text-green-400">none (no key can upgrade the program)</span> : '--'}
                    </Row>
                    <Row label="Last deploy slot">{upg.data?.lastDeploySlot ? formatNumber(upg.data.lastDeploySlot) : '--'}</Row>
                </div>
                {upg.data && authority && (
                    <Notice kind="warn" className="mt-4">
                        The program is <strong>upgradeable</strong> during the test period: the key above can deploy new code, which could change any rule
                        on this page. The plan is to burn the upgrade authority after the test period (see{' '}
                        <a href={PROJECT_LINKS.securityMd} target="_blank" rel="noopener noreferrer" className="underline">SECURITY.md</a>).
                        Until this field reads "none", trust the upgrade key accordingly. Verify: <code>solana program show {PROGRAM_ID.toBase58()} --url https://rpc.mainnet.x1.xyz</code>
                    </Notice>
                )}
                {noAuthority && <Notice kind="success" className="mt-4">No upgrade authority: no key can deploy new code to this program.</Notice>}
                {upg.error && <Notice kind="error" className="mt-4">{upg.error}</Notice>}
            </section>

            {/* Config */}
            <section className="glass-card">
                <div className="flex items-center gap-2 mb-4"><Database className="w-5 h-5 text-forge-gold" /><h2 className="font-space text-xl">Live configuration</h2></div>
                {proto.error && <Notice kind="error">{proto.error}</Notice>}
                {proto.data && !proto.data.initialized && <Notice kind="warn">Config account not initialized yet (permissionless <code>initialize_v2</code>).</Notice>}
                <div className="grid md:grid-cols-2 gap-x-8">
                    <Row label="Config PDA"><AddrLink address={PDA.config()} /></Row>
                    <Row label="Oracle key">{cfg ? <AddrLink address={cfg.oracle} /> : '--'}</Row>
                    <Row label="Pending oracle (hand-over)">{cfg ? (cfg.pendingOracle.toBase58() === '11111111111111111111111111111111' ? 'none' : <AddrLink address={cfg.pendingOracle} />) : '--'}</Row>
                    <Row label="Architect">{cfg ? <AddrLink address={cfg.architect} /> : '--'}</Row>
                    <Row label="Last epoch">{cfg ? `#${last}` : '--'}</Row>
                    <Row label="Last publish">{cfg ? ts(cfg.lastPublishTs) : '--'}</Row>
                    <Row label="Reward reserved for open epochs"><Xnt lamports={proto.data ? proto.data.rewardReserved : null} /></Row>
                    <Row label="Bankroll reserved for open bets"><Xnt lamports={proto.data ? proto.data.bankrollReserved : null} /></Row>
                    <Row label="Jackpot round / Lottery week">{cfg ? `#${n(cfg.jackpotRound)} / #${n(cfg.drawRound)}` : '--'}</Row>
                    <Row label="House shares (total / protocol floor)">{cfg ? `${formatNumber(n(cfg.houseTotalShares)!, 0)} / ${formatNumber(n(cfg.houseProtocolShares)!, 0)}` : '--'}</Row>
                    <Row label="Artifacts alive">{cfg ? (cfg.artifactsAlive as number[]).map((v: number, i: number) => `${ARTIFACTS[i].name.split(' ')[0]} ${v}`).join(' · ') : '--'}</Row>
                    <Row label="Airdrop list / claimed">{cfg ? `${cfg.airdropRootSet ? 'set' : 'not set'} · ${n(cfg.airdropClaimed)} / ${AIRDROP_MAX}` : '--'}</Row>
                </div>
            </section>

            {/* Vaults */}
            <section className="glass-card">
                <h2 className="font-space text-xl mb-4">Vaults (balance minus rent)</h2>
                <div className="grid md:grid-cols-3 gap-4">
                    <div className="bg-space-700/40 rounded-xl p-4">
                        <div className="text-sm text-white mb-1">Reward pool <AddrLink address={PDA.rewardVault()} /></div>
                        <Row label="Total"><Xnt lamports={proto.data ? proto.data.rewardTotal : null} /></Row>
                        <Row label="Reserved"><Xnt lamports={proto.data ? proto.data.rewardReserved : null} /></Row>
                        <Row label="Free"><Xnt lamports={proto.data ? proto.data.rewardFree : null} /></Row>
                        <Row label="Max next epoch budget (10%)"><Xnt lamports={proto.data ? proto.data.nextEpochBudget : null} /></Row>
                    </div>
                    <div className="bg-space-700/40 rounded-xl p-4">
                        <div className="text-sm text-white mb-1">Game bankroll <AddrLink address={PDA.bankrollVault()} /></div>
                        <Row label="Free"><Xnt lamports={proto.data ? proto.data.bankrollFree : null} /></Row>
                        <Row label="Reserved"><Xnt lamports={proto.data ? proto.data.bankrollReserved : null} /></Row>
                        <Row label="Max net win per bet (0.25%)"><Xnt lamports={proto.data ? proto.data.maxNetWin : null} /></Row>
                    </div>
                    <div className="bg-space-700/40 rounded-xl p-4">
                        <div className="text-sm text-white mb-1">Burn Lottery <AddrLink address={PDA.drawVault()} /></div>
                        <Row label="Vault"><Xnt lamports={proto.data ? proto.data.drawVault : null} /></Row>
                        <Row label="Prize if drawn now (50%)"><Xnt lamports={proto.data ? Math.floor(proto.data.drawVault / 2) : null} /></Row>
                    </div>
                </div>
            </section>

            {/* Stats */}
            <section className="glass-card">
                <h2 className="font-space text-xl mb-4">Lifetime statistics (on-chain counters)</h2>
                <div className="grid md:grid-cols-3 gap-x-8">
                    <Row label="XNT paid to burners"><Xnt lamports={n(stats?.forgePaid)} /></Row>
                    <Row label="Forge claims">{stats ? formatNumber(n(stats.forgeClaims)!) : '--'}</Row>
                    <Row label="Keeper tips (from pool)"><Xnt lamports={n(stats?.keeperTips)} /></Row>
                    <Row label="Forge Drops won">{stats ? formatNumber(n(stats.drops)!) : '--'}</Row>
                    <Row label="Forge Drop floors paid"><Xnt lamports={n(stats?.dropPaid)} /></Row>
                    <Row label="Eject penalties to pool"><Xnt lamports={n(stats?.penaltiesToPool)} /></Row>
                    <Row label="Donated: reward pool"><Xnt lamports={n(stats?.donatedReward)} /></Row>
                    <Row label="Donated: bankroll"><Xnt lamports={n(stats?.donatedBankroll)} /></Row>
                    <Row label="Donated: lottery"><Xnt lamports={n(stats?.donatedDraw)} /></Row>
                    <Row label="Wagered (house games)"><Xnt lamports={n(stats?.wagered)} /></Row>
                    <Row label="Bets">{stats ? formatNumber(n(stats.bets)!) : '--'}</Row>
                    <Row label="Paid to players"><Xnt lamports={n(stats?.paidToPlayers)} /></Row>
                    <Row label="Edge + rake to reward pool"><Xnt lamports={n(stats?.edgeToPool)} /></Row>
                    <Row label="Artifacts to reward pool"><Xnt lamports={n(stats?.artifactToPool)} /></Row>
                    <Row label="To lottery vault (rake + forges)"><Xnt lamports={n(stats?.toDraw)} /></Row>
                    <Row label="Lottery prizes paid"><Xnt lamports={n(stats?.drawPrizes)} /></Row>
                    <Row label="Expired lottery prizes to pool"><Xnt lamports={n(stats?.expiredDrawsToPool)} /></Row>
                    <Row label={<span className="text-amber-300">Total paid to architect</span>}><Xnt lamports={n(stats?.toArchitect)} /></Row>
                </div>
            </section>

            {/* Who can do what */}
            <section className="glass-card">
                <div className="flex items-center gap-2 mb-4"><Users className="w-5 h-5 text-forge-gold" /><h2 className="font-space text-xl">Who can do what (complete list, from lib.rs)</h2></div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <tbody>
                            {[
                                ['Anyone', `Donate; claim burns for anyone (the XNT goes to the player in the leaf; ${P.keeperTip} XNT tip per claim of ≥ ${P.keeperTipMinClaim} XNT submitted for someone else, paid by the pool, never by the player); push vested XNT; seal and deliver Forge Drops (${P.dropKeeperTip} XNT tip from the pool when delivering for someone else); settle bets, rounds and draws; pay back refunded Jackpot entries; expire epochs; sweep v1 accounts; reclaim orphan Artifacts; initialize accounts.`],
                                ['Players (wallet owner)', 'Game wallet, house games, Jackpot, Duel, Burn Lottery, Be the House, forge / recycle Artifacts, eject early from a vesting mission. Jackpot, Burn Lottery and Duels can only be entered by the wallet owner.'],
                                ['Session keys (bots)', 'House games only, from the owner\'s game balance. Cannot withdraw and cannot enter Jackpot, Burn Lottery or Duels (error OwnerOnly).'],
                                ['Oracle key', `publish_epoch with the epoch rate cap (the budget = min(${P.epochBudgetBps / 100}% of the free pool, total_score × rate_cap) is computed on-chain; at most once per ${P.minEpochIntervalDays} days) and hand its role to a new key. Nothing else: it cannot move funds itself.`],
                                ['Architect', `set_airdrop_root once. Nothing else. Receives only: ${P.edgeToArchitectPct}% of house-game stakes, ${P.rakeToArchitectPct}% of Jackpot / Duel pots with a winner and of every lottery ticket, ${FORGE_SPLIT.architectPct}% of the forge price, and a ${SECONDARY_ROYALTY_PCT}% secondary royalty where marketplaces honor Core royalties. Nothing from burns, claims or Forge Drops; while its wallet is below rent exemption, its cut goes to the reward pool.`],
                                ['Upgrade authority', 'Held by the architect wallet during the test period, to be burned afterwards. Can replace the program code (see the live field above).'],
                            ].map(([who, what]) => (
                                <tr key={who} className="border-b border-white/5 align-top">
                                    <td className="py-2 pr-4 text-forge-gold whitespace-nowrap">{who}</td>
                                    <td className="py-2 text-lunar-300">{what}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>

            {/* Fees */}
            <section className="glass-card">
                <h2 className="font-space text-xl mb-4">Every fee and split</h2>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead><tr className="text-left text-lunar-400 border-b border-white/10"><th className="py-2 pr-3">Flow</th><th className="py-2 pr-3">Fee</th><th className="py-2">Where it goes</th></tr></thead>
                        <tbody className="text-lunar-300">
                            <tr className="border-b border-white/5"><td className="py-2 pr-3">Burn → claim → XNT</td><td className="py-2 pr-3 text-green-400">0%</td><td className="py-2">Nothing taken. Keeper tip ({P.keeperTip} XNT per claim of ≥ {P.keeperTipMinClaim} XNT submitted for someone else) is paid by the pool, never by the player.</td></tr>
                            <tr className="border-b border-white/5"><td className="py-2 pr-3">Forge Drop delivery</td><td className="py-2 pr-3 text-green-400">0%</td><td className="py-2">Nothing taken. Delivery tip ({P.dropKeeperTip} XNT per drop delivered for someone else) is paid by the pool, never by the player.</td></tr>
                            <tr className="border-b border-white/5"><td className="py-2 pr-3">Eject (Orbit / Moon Landing)</td><td className="py-2 pr-3">{P.tiers[1].penaltyPct}% / {P.tiers[2].penaltyPct}% of the unvested part</td><td className="py-2">100% to the reward pool</td></tr>
                            <tr className="border-b border-white/5"><td className="py-2 pr-3">House games (every stake)</td><td className="py-2 pr-3">{P.houseEdgePct}% edge in the odds</td><td className="py-2">{P.edgeToPoolPct}% reward pool · {P.edgeToArchitectPct}% architect · {P.edgeToBankrollPct}% stays in bankroll</td></tr>
                            <tr className="border-b border-white/5"><td className="py-2 pr-3">Jackpot / Duel pot (only with a winner)</td><td className="py-2 pr-3">{P.p2pRakePct}%</td><td className="py-2">{P.rakeToPoolPct}% reward pool · {P.rakeToArchitectPct}% architect · {P.rakeToDrawPct}% lottery vault</td></tr>
                            <tr className="border-b border-white/5"><td className="py-2 pr-3">Lottery tickets (at purchase)</td><td className="py-2 pr-3">{P.p2pRakePct}%</td><td className="py-2">{P.rakeToPoolPct}% reward pool · {P.rakeToArchitectPct}% architect · {P.rakeToDrawPct}% back to the lottery vault (so {100 - P.p2pRakePct + P.rakeToDrawPct}% of each ticket goes to the prize vault)</td></tr>
                            <tr className="border-b border-white/5"><td className="py-2 pr-3">Artifact forge</td><td className="py-2 pr-3">—</td><td className="py-2">{FORGE_SPLIT.floorPct}% floor inside the NFT · {FORGE_SPLIT.poolPct}% reward pool · {FORGE_SPLIT.drawPct}% lottery vault · {FORGE_SPLIT.architectPct}% architect</td></tr>
                            <tr className="border-b border-white/5"><td className="py-2 pr-3">Artifact secondary sale</td><td className="py-2 pr-3">{SECONDARY_ROYALTY_PCT}% royalty (declared)</td><td className="py-2">Architect, where the marketplace honors Core royalties</td></tr>
                            <tr><td className="py-2 pr-3">Donations</td><td className="py-2 pr-3 text-green-400">0%</td><td className="py-2">100% to the chosen vault</td></tr>
                        </tbody>
                    </table>
                </div>
            </section>

            {/* Constants */}
            <section className="glass-card">
                <h2 className="font-space text-xl mb-4">Key constants (compile-time, <a href={PROJECT_LINKS.programConstants} target="_blank" rel="noopener noreferrer" className="text-forge-orange hover:underline">constants.rs</a>)</h2>
                <div className="grid md:grid-cols-2 gap-x-8">
                    <Row label="Epoch budget">min({P.epochBudgetBps / 100}% of the free reward pool, total_score × rate_cap), computed on-chain</Row>
                    <Row label="Time between epochs">weekly (Sundays 00:00 UTC); program minimum {P.minEpochIntervalDays} days</Row>
                    <Row label="Claim window">{P.claimWindowDays} days, then unclaimed budget returns to the pool</Row>
                    <Row label="Forge Drops">
                        {P.dropBudgetPct}% of each epoch budget, capped at {P.maxDropsPerEpoch * P.dropBackingXnt} XNT ({P.maxDropsPerEpoch} × {P.dropBackingXnt} XNT), part of the budget,
                        drawn as Lunar Dust with a floor = drop value (≥ {P.dropBackingXnt} XNT). Unsealed within ~512 slots → cancelled, reserve back to the pool. Luck overrun paid
                        from the free pool, bounded by reserve + max(reserve, {P.dropLuckBufferXnt} XNT)
                    </Row>
                    <Row label="Epoch rate cap">
                        rate_cap = {P.rateCapK} × XNT-per-USD × base_score / total_score (supplied by the oracle, must be &gt; 0; recomputed by the verifier): an epoch pays at most
                        {' '}{P.rateCapK}× / {P.rateCapK * 2}× / {P.rateCapK * 3}× the liquidity-adjusted value burned (Launchpad / Orbit / Moon Landing)
                    </Row>
                    <Row label="Tiers">Launchpad 1× instant · Orbit 2× / 45 d · Moon Landing 3× / 180 d</Row>
                    <Row label="Eject penalty">Orbit {P.tiers[1].penaltyPct}% · Moon Landing {P.tiers[2].penaltyPct}% (of the unvested part)</Row>
                    <Row label="House exposure cap">max net win per bet = {P.maxExposurePct}% of the free bankroll; all unsettled payouts ≤ {P.maxTotalExposurePct}% of it</Row>
                    <Row label="Circuit breaker">if the bankroll (net of LP deposits / withdrawals) has lost 10% since the start of the UTC day, new house bets are refused until the next day</Row>
                    <Row label="Min stake / Duel min">{P.minStake} XNT / {P.duelMinStake} XNT</Row>
                    <Row label="Jackpot / Duel reveal / Lottery">{P.jackpotMinutes} min / {P.duelRevealMinutes} min / {P.drawDays} days</Row>
                    <Row label="Be the House">{P.houseWithdrawHours} h cooldown, min deposit 1 XNT; deposits priced as if pending bets lose, withdrawals as if they win (priced when you withdraw); 1% slippage limit in the app</Row>
                    <Row label="Chips">{P.chipPerClaimedXnt} per XNT received from burns · 1 per {P.chipPerWageredXnt} XNT wagered · {ARTIFACTS.map((a) => a.weeklyChips).join(' / ')} per Artifact per week (resets Thursdays 00:00 UTC)</Row>
                    <Row label="Session keys (bots)">house games only; cannot withdraw or enter Jackpot, Burn Lottery or Duels</Row>
                    <Row label="Unsettled house bet">counts as lost after ~3 minutes (SlotHashes window), even if its roll was a win</Row>
                    <Row label="Unsettled Jackpot / lottery draw">Jackpot refunded entry by entry / lottery: no winner, the would-be prize goes to the reward pool (never re-drawn)</Row>
                </div>
            </section>

            {/* Epochs */}
            <section className="glass-card">
                <div className="flex items-center gap-2 mb-4"><FileCheck2 className="w-5 h-5 text-green-400" /><h2 className="font-space text-xl">Epochs</h2></div>
                {index.error && <Notice kind="error">{index.error}</Notice>}
                {(index.data?.epochs.length ?? 0) === 0 && ids.length === 0 && <p className="text-sm text-lunar-400">No epoch published yet.</p>}
                {(ids.length > 0 || (index.data?.epochs.length ?? 0) > 0) && (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-lunar-400 border-b border-white/10">
                                    <th className="py-2 pr-3">Epoch</th><th className="py-2 pr-3">Leaves</th><th className="py-2 pr-3">Budget</th><th className="py-2 pr-3">Claimed</th>
                                    <th className="py-2 pr-3">Published</th><th className="py-2 pr-3">Status</th><th className="py-2 pr-3">File</th><th className="py-2">Tx</th>
                                </tr>
                            </thead>
                            <tbody>
                                {Array.from(new Set([...ids, ...(index.data?.epochs ?? []).map((e) => e.epoch)])).sort((a, b) => b - a).map((id) => {
                                    const file = index.data?.epochs.find((e) => e.epoch === id);
                                    const k = ids.indexOf(id);
                                    const acc = k >= 0 ? epochs.data?.[k] : null;
                                    const now = Date.now() / 1000;
                                    return (
                                        <tr key={id} className="border-b border-white/5">
                                            <td className="py-2 pr-3">#{id}</td>
                                            <td className="py-2 pr-3">{acc ? acc.leaves : file ? file.leaves : '--'}</td>
                                            <td className="py-2 pr-3"><Xnt lamports={acc ? n(acc.budget) : null} digits={2} /></td>
                                            <td className="py-2 pr-3"><Xnt lamports={acc ? n(acc.claimed) : null} digits={2} /> {acc ? `(${acc.claims})` : ''}</td>
                                            <td className="py-2 pr-3 text-xs">{acc ? ts(acc.publishedAt) : file ? new Date(file.createdAt).toLocaleString() : '--'}</td>
                                            <td className="py-2 pr-3 text-xs">{acc ? (acc.closed ? 'closed' : now >= Number(acc.expiresAt) ? 'window over' : 'claimable') : 'not on chain'}</td>
                                            <td className="py-2 pr-3">{file ? <a className="text-forge-orange hover:underline text-xs" href={`${import.meta.env.BASE_URL}epochs/epoch-${id}.json`} target="_blank" rel="noopener noreferrer">epoch-{id}.json</a> : '--'}</td>
                                            <td className="py-2">{file?.tx ? <a className="text-forge-orange hover:underline text-xs font-mono" href={explorerTx(file.tx)} target="_blank" rel="noopener noreferrer">{file.tx.slice(0, 10)}…</a> : '--'}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
                <div className="mt-4 p-4 rounded-xl bg-black/30">
                    <div className="text-sm text-white font-bold mb-2">Verify it yourself</div>
                    <p className="text-xs text-lunar-400 mb-2">
                        Each epoch file contains every burn, the prices used, the Artifact snapshot, every leaf and proof. The verifier recomputes the scores,
                        the Merkle root and the data hash, and checks them against the Epoch account on X1:
                    </p>
                    <pre className="text-xs font-mono text-green-300 overflow-x-auto">cd oracle && npm install && npm run verify -- ../frontend/public/epochs/epoch-N.json --full</pre>
                    <p className="text-xs text-lunar-500 mt-2">
                        Source: <a href={PROJECT_LINKS.oracle} target="_blank" rel="noopener noreferrer" className="text-forge-orange hover:underline">oracle/</a> ·
                        {' '}<a href={PROJECT_LINKS.program} target="_blank" rel="noopener noreferrer" className="text-forge-orange hover:underline">program</a> ·
                        {' '}<a href={PROJECT_LINKS.portal} target="_blank" rel="noopener noreferrer" className="text-forge-orange hover:underline">EVM portal</a>.
                        No third-party security audit has been published.
                    </p>
                </div>
            </section>
        </div>
    );
}
