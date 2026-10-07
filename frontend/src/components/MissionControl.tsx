/**
 * Mission Control — everything a burner does on X1:
 *  • Claimable rewards (epoch leaves for this wallet) → claim_instant / claim_mission
 *  • Forge Drops (part of the epoch budget, drawn per leaf as Lunar Dust with a real floor) → claim_drop
 *  • Vesting missions → withdraw vested (permissionless push) or eject (exact preview, in-page confirm)
 *  • Game wallet summary (balance, lottery chips)
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { Rocket, Gift, Wallet, RefreshCw, LogOut } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import { usePoll, useTx, useNow } from '../lib/hooks';
import {
    claimDrop, claimLeaf, ejectPreview, eject, fetchMissions, fetchMyLeaves, fetchPlayer, MyLeaf, P, toXnt, vestedNow, withdrawVested,
} from '../lib/protocol';
import { formatDuration, formatNumber } from '../lib/constants';
import { AddrLink, Notice, Row, StatTile, TxStatus, Xnt } from './ui';

export default function MissionControl() {
    const { x1Connected, x1Address, x1Provider, connectX1, isConnecting } = useWallet();
    const [viewInput, setViewInput] = useState('');
    const [viewAddr, setViewAddr] = useState<string | null>(null);
    const [viewErr, setViewErr] = useState<string | null>(null);

    const owner = x1Connected && x1Address ? x1Address : viewAddr;
    const readOnly = !(x1Connected && x1Address);

    return (
        <div className="max-w-5xl mx-auto">
            <div className="text-center mb-8">
                <h1 className="font-space text-4xl font-bold mb-2"><span className="text-forge-gold">🚀</span> Mission Control</h1>
                <p className="text-lunar-400">Claim your XNT, follow your vesting missions, withdraw or eject.</p>
            </div>

            {!x1Connected && (
                <div className="glass-card mb-6">
                    <div className="flex flex-col md:flex-row md:items-end gap-4">
                        <div className="flex-1">
                            <p className="text-sm text-lunar-300 mb-2">Connect your X1 wallet to claim, withdraw or eject.</p>
                            <button onClick={connectX1} disabled={isConnecting} className="btn-forge">{isConnecting ? 'Connecting…' : 'Connect X1 Wallet'}</button>
                        </div>
                        <div className="flex-1">
                            <label className="text-xs text-lunar-400">Or view any X1 address (read-only, Base58)</label>
                            <div className="flex gap-2 mt-1">
                                <input className="input-forge font-mono text-sm !py-2" value={viewInput} onChange={(e) => setViewInput(e.target.value)} placeholder="X1 address" />
                                <button
                                    className="btn-outline !px-4 !py-2 text-sm"
                                    onClick={() => {
                                        try {
                                            if (viewInput.trim().toLowerCase().startsWith('0x')) throw new Error();
                                            setViewAddr(new PublicKey(viewInput.trim()).toBase58());
                                            setViewErr(null);
                                        } catch {
                                            setViewErr('Not a valid X1 (Base58) address. EVM 0x addresses are not used on X1.');
                                        }
                                    }}
                                >
                                    View
                                </button>
                            </div>
                            {viewErr && <p className="text-xs text-red-400 mt-1">{viewErr}</p>}
                        </div>
                    </div>
                </div>
            )}

            {owner ? (
                <Dashboard key={owner} owner={owner} readOnly={readOnly} provider={readOnly ? null : x1Provider} />
            ) : null}
        </div>
    );
}

function Dashboard({ owner, readOnly, provider }: { owner: string; readOnly: boolean; provider: ReturnType<typeof useWallet>['x1Provider'] }) {
    const ownerPk = new PublicKey(owner);
    const leaves = usePoll(() => fetchMyLeaves(ownerPk), [owner], 60_000);
    const missions = usePoll(() => fetchMissions(ownerPk), [owner], 60_000);
    const player = usePoll(() => fetchPlayer(ownerPk), [owner], 30_000);
    const tx = useTx();
    const now = useNow(5000);
    const [confirmEject, setConfirmEject] = useState<string | null>(null);

    const reloadAll = () => { leaves.reload(); missions.reload(); player.reload(); };

    const doClaim = (l: MyLeaf) => provider && tx.run(`Claiming epoch ${l.epoch}`, () => claimLeaf(provider, l), reloadAll);
    const doDrop = (l: MyLeaf) => provider && tx.run(`Receiving the Forge Drop of epoch ${l.epoch}`, () => claimDrop(provider, l), reloadAll);
    const doWithdraw = (m: any) => provider && tx.run('Withdrawing vested XNT', () => withdrawVested(provider, m), reloadAll);
    const doEject = (m: any) => provider && tx.run('Ejecting', () => eject(provider, m), () => { setConfirmEject(null); reloadAll(); });

    const pending = (leaves.data ?? []).filter((l) => !l.claimed && !l.expired);
    const ps = player.data;

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between text-sm">
                <div className="text-lunar-400">Wallet: <AddrLink address={owner} /> {readOnly && <span className="text-amber-400 ml-2">(read-only view)</span>}</div>
                <button onClick={reloadAll} className="flex items-center gap-1 text-lunar-400 hover:text-white"><RefreshCw className="w-4 h-4" /> Refresh</button>
            </div>

            <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />

            {/* Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatTile label="Claimable leaves" value={leaves.data ? pending.length : '--'} sub={leaves.data ? <>≈ <Xnt lamports={pending.reduce((a, l) => a + l.estimate, 0)} digits={2} /></> : undefined} />
                <StatTile label="Vesting missions" value={missions.data ? missions.data.length : '--'} />
                <StatTile label="Game balance" value={ps ? <Xnt lamports={Number(ps.balance)} digits={3} /> : player.loading ? '--' : '0 XNT'} sub={<Link to="/games" className="text-forge-orange hover:underline">Games</Link>} />
                <StatTile label="Lottery chips" value={ps ? formatNumber(Number(ps.chips)) : player.loading ? '--' : '0'} sub="Burn Lottery entries" />
            </div>

            {/* Claimable */}
            <section className="glass-card">
                <div className="flex items-center gap-2 mb-4">
                    <Gift className="w-5 h-5 text-forge-gold" />
                    <h2 className="font-space text-xl">Claimable rewards</h2>
                </div>
                {leaves.error && <Notice kind="error">{leaves.error}</Notice>}
                {leaves.loading && !leaves.data && <p className="text-lunar-400 text-sm">Reading published epochs…</p>}
                {leaves.data && leaves.data.length === 0 && (
                    <p className="text-lunar-400 text-sm">
                        No burn of this wallet appears in the published epochs (last 20). Burns are scored in the next epoch after they are final on their chain.
                    </p>
                )}
                {leaves.data && leaves.data.length > 0 && (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-lunar-400 border-b border-white/10">
                                    <th className="py-2 pr-3">Epoch</th>
                                    <th className="py-2 pr-3">Tier</th>
                                    <th className="py-2 pr-3">Score</th>
                                    <th className="py-2 pr-3">Estimate</th>
                                    <th className="py-2 pr-3">Window</th>
                                    <th className="py-2 pr-3">Status</th>
                                    <th className="py-2">Forge Drop</th>
                                </tr>
                            </thead>
                            <tbody>
                                {leaves.data.map((l) => (
                                    <tr key={`${l.epoch}-${l.tier}`} className="border-b border-white/5">
                                        <td className="py-2 pr-3">#{l.epoch}</td>
                                        <td className="py-2 pr-3">{P.tiers[l.tier]?.icon} {P.tiers[l.tier]?.name}</td>
                                        <td className="py-2 pr-3 font-mono text-xs">{l.score}</td>
                                        <td className="py-2 pr-3">{l.onChain ? <Xnt lamports={l.estimate} /> : '--'}</td>
                                        <td className="py-2 pr-3 text-xs text-lunar-400">{l.onChain && !l.claimed && !l.expired ? `${formatDuration(l.expiresAt - now)} left` : '--'}</td>
                                        <td className="py-2 pr-3">
                                            {l.claimed ? <span className="text-green-400">Claimed</span>
                                                : l.expired ? <span className="text-lunar-500">Expired (returned to pool)</span>
                                                    : !l.onChain ? <span className="text-amber-400">Epoch not on chain yet</span>
                                                        : readOnly ? <span className="text-lunar-300">Claimable</span>
                                                            : (
                                                                <button onClick={() => doClaim(l)} disabled={!!tx.busy} className="btn-forge !px-3 !py-1 text-xs">
                                                                    Claim
                                                                </button>
                                                            )}
                                        </td>
                                        <td className="py-2 text-xs">
                                            {!l.onChain || l.drop.state === 0 ? <span className="text-lunar-500">--</span>
                                                : l.drop.state === 1 ? <span className="text-amber-400">Drawing… ({(l.drop.chance * 100).toFixed(l.drop.chance < 0.01 ? 2 : 0)}% chance)</span>
                                                    : l.drop.state === 3 ? <span className="text-lunar-500">Not drawn (reserve back to pool)</span>
                                                        : l.drop.claimed ? <span className="text-green-400">Received ✓</span>
                                                            : !l.drop.won ? <span className="text-lunar-400">No drop ({(l.drop.chance * 100).toFixed(l.drop.chance < 0.01 ? 2 : 0)}% chance)</span>
                                                                : l.expired ? <span className="text-lunar-500">Won, window closed</span>
                                                                    : readOnly ? <span className="text-forge-gold">Won: Lunar Dust (<Xnt lamports={l.drop.value} digits={2} /> floor)</span>
                                                                        : (
                                                                            <button onClick={() => doDrop(l)} disabled={!!tx.busy} className="btn-forge !px-3 !py-1 text-xs">
                                                                                Receive drop (<Xnt lamports={l.drop.value} digits={2} />)
                                                                            </button>
                                                                        )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                <p className="text-xs text-lunar-500 mt-3">
                    Estimate = your score × (epoch budget minus its Forge Drop reserve) ÷ total score (what the program pays). Launchpad goes
                    straight to your wallet (a payout that would leave a brand-new wallet below the rent-exempt minimum is credited to your game
                    balance instead); Orbit / Moon Landing open a vesting mission that starts vesting at the claim. Claims are permissionless:
                    when the public keeper is running it usually submits them for you (runs can be delayed); its {P.keeperTip} XNT tip per claim of
                    at least {P.keeperTipMinClaim} XNT is paid by the pool, never from your amount. Whoever submits a claim pays a small rent deposit:
                    the claim receipt's rent is refunded to them after the epoch closes, a vesting mission's rent when the mission ends (the game
                    wallet created at a first claim is not refundable). Unclaimed budgets return to the pool after {P.claimWindowDays} days.
                </p>
                <p className="text-xs text-lunar-500 mt-2">
                    Forge Drops: up to {P.dropBudgetPct}% of every epoch budget (max {P.maxDropsPerEpoch * P.dropBackingXnt} XNT) is not paid pro-rata
                    but drawn as Lunar Dust Artifacts whose floor is the drop value, at least {P.dropBackingXnt} XNT (recycle any time for it). This
                    is part of the epoch budget, not extra, and is paid in XNT if Lunar Dust is sold out. Your chance = your expected drop value
                    ÷ {P.dropBackingXnt} XNT, so it grows linearly with what you burned: splitting a burn across wallets never changes your expected
                    drop value. The draw uses the hash of a block produced after the epoch was published (not known to the oracle or the protocol
                    at publication; its block producer could in theory influence it) and anyone can recompute every outcome. Leaves whose expected
                    value is at or above {P.dropBackingXnt} XNT always win and the whole value becomes the floor. When the public keeper is running
                    it usually delivers the drop for you (runs can be delayed); otherwise press "Receive drop". A won drop must be received within
                    the epoch's {P.claimWindowDays}-day window.
                </p>
            </section>

            {/* Missions */}
            <section className="glass-card">
                <div className="flex items-center gap-2 mb-4">
                    <Rocket className="w-5 h-5 text-mission-orbit" />
                    <h2 className="font-space text-xl">Vesting missions</h2>
                </div>
                {missions.error && <Notice kind="error">{missions.error}</Notice>}
                {missions.data && missions.data.length === 0 && <p className="text-lunar-400 text-sm">No open Orbit / Moon Landing mission for this wallet.</p>}
                <div className="space-y-4">
                    {(missions.data ?? []).map((m: any) => {
                        const a = m.account;
                        const t = P.tiers[Number(a.tier)];
                        const v = vestedNow(a, now);
                        const total = Number(a.total);
                        const pct = total > 0 ? Math.min(100, (v.vested / total) * 100) : 0;
                        const key = m.publicKey.toBase58();
                        const preview = ejectPreview(a, now);
                        const endTs = Number(a.end);
                        return (
                            <div key={key} className={`p-4 rounded-xl bg-space-700/40 border border-white/5 ${Number(a.tier) === 2 ? 'tier-moon' : 'tier-orbit'}`}>
                                <div className="flex flex-wrap items-center gap-3 mb-3">
                                    <span className="text-2xl">{t?.icon}</span>
                                    <span className="font-space text-white">{t?.name}</span>
                                    <span className="text-xs text-lunar-400">epoch #{Number(a.epoch)}</span>
                                    <span className="ml-auto text-xs text-lunar-400">{now >= endTs ? 'Fully vested' : `${formatDuration(endTs - now)} to full vesting`}</span>
                                </div>
                                <div className="w-full h-3 bg-space-600 rounded-full overflow-hidden mb-3">
                                    <div className="h-full bg-gradient-to-r from-forge-orange to-forge-gold" style={{ width: `${pct}%` }} />
                                </div>
                                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm mb-3">
                                    <div><div className="text-xs text-lunar-400">Total</div><Xnt lamports={total} /></div>
                                    <div><div className="text-xs text-lunar-400">Vested ({pct.toFixed(1)}%)</div><Xnt lamports={v.vested} /></div>
                                    <div><div className="text-xs text-lunar-400">Withdrawn</div><Xnt lamports={Number(a.withdrawn)} /></div>
                                    <div><div className="text-xs text-lunar-400">Withdrawable now</div><Xnt lamports={v.withdrawable} className="text-forge-gold" /></div>
                                </div>

                                {!readOnly && (
                                    <div className="flex flex-wrap gap-2">
                                        <button onClick={() => doWithdraw(m)} disabled={!!tx.busy || v.withdrawable <= 0} className="btn-forge !px-4 !py-2 text-sm flex items-center gap-1">
                                            <Wallet className="w-4 h-4" /> Withdraw vested
                                        </button>
                                        {v.unvested > 0 && (
                                            <button onClick={() => setConfirmEject(confirmEject === key ? null : key)} disabled={!!tx.busy} className="btn-outline !px-4 !py-2 text-sm flex items-center gap-1 !border-red-400 !text-red-400 hover:!bg-red-400 hover:!text-space-900">
                                                <LogOut className="w-4 h-4" /> Eject…
                                            </button>
                                        )}
                                    </div>
                                )}

                                {confirmEject === key && !readOnly && (
                                    <div className="mt-4 p-4 rounded-xl border border-red-500/40 bg-red-500/5">
                                        <p className="text-sm text-white font-bold mb-2">Eject preview (computed exactly like the program, at this moment)</p>
                                        <Row label="Vested, not yet withdrawn (paid in full)"><Xnt lamports={preview.vestedUnpaid} /></Row>
                                        <Row label="Unvested">{toXnt(preview.unvested).toFixed(4)} XNT</Row>
                                        <Row label={`Penalty: ${t?.penaltyPct}% of the unvested part → reward pool`}><span className="text-red-400">−{toXnt(preview.penalty).toFixed(4)} XNT</span></Row>
                                        <Row label={`You keep ${100 - (t?.penaltyPct ?? 0)}% of the unvested part`}>{toXnt(preview.unvested - preview.penalty).toFixed(4)} XNT</Row>
                                        <hr className="border-white/10 my-2" />
                                        <Row label={<strong>You receive now</strong>}><strong className="text-forge-gold"><Xnt lamports={preview.paid} /></strong></Row>
                                        <p className="text-xs text-lunar-500 mt-2">
                                            The mission closes. The penalty goes 100% to the burners' reward pool. A few more seconds of vesting may accrue before your
                                            transaction lands, so you can receive marginally more than shown.
                                        </p>
                                        <div className="flex gap-2 mt-3">
                                            <button onClick={() => doEject(m)} disabled={!!tx.busy} className="px-4 py-2 rounded-xl bg-red-500 text-white font-bold text-sm hover:bg-red-400 disabled:opacity-50">
                                                Confirm eject
                                            </button>
                                            <button onClick={() => setConfirmEject(null)} className="btn-outline !px-4 !py-2 text-sm">Cancel</button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
                <p className="text-xs text-lunar-500 mt-3">
                    Vesting starts when the leaf is claimed (by you or a keeper). The keeper does not push vested XNT automatically: use
                    "Withdraw vested" (it is permissionless, so anyone can push it to you). Ejecting pays the vested part in full plus
                    {` ${100 - P.tiers[1].penaltyPct}%`} (Orbit) / {100 - P.tiers[2].penaltyPct}% (Moon Landing) of the unvested part. Chips are
                    credited on the vested XNT you actually withdraw or receive at eject, never on the part lost to a penalty. A mission's rent
                    is refunded to whoever paid it when the mission ends.
                </p>
            </section>

            {/* Game wallet */}
            <section className="glass-card">
                <h2 className="font-space text-xl mb-3">Game wallet</h2>
                {player.error && <Notice kind="error">{player.error}</Notice>}
                {ps ? (
                    <div className="grid md:grid-cols-2 gap-x-8">
                        <Row label="Balance"><Xnt lamports={Number(ps.balance)} /></Row>
                        <Row label="Lottery chips">{formatNumber(Number(ps.chips))}</Row>
                        <Row label="Total wagered"><Xnt lamports={Number(ps.totalWagered)} /></Row>
                        <Row label="Total won"><Xnt lamports={Number(ps.totalWon)} /></Row>
                    </div>
                ) : (
                    <p className="text-sm text-lunar-400">{player.loading ? 'Reading…' : 'No game wallet yet. It is created automatically at your first claim or deposit (its rent is not refundable).'}</p>
                )}
                <p className="text-xs text-lunar-500 mt-2">
                    Chips: {P.chipPerClaimedXnt} per XNT actually received from burns (Launchpad at claim; Orbit / Moon Landing as vested XNT is
                    withdrawn or at eject, never on the penalty part), 1 per {P.chipPerWageredXnt} XNT wagered in house games, plus weekly chips
                    per Artifact.
                    Spend them in the <Link to="/games" className="text-forge-orange hover:underline">Burn Lottery</Link>.
                </p>
            </section>
        </div>
    );
}
