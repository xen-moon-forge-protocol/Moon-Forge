/**
 * Moon Forge Artifacts — Metaplex Core NFTs forged and recycled by the Moon Forge program.
 * Single NFT page (also served at /nft and /marketplace).
 */
import { useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { Gem, Recycle, Ticket, Gift, Store } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import { useNow, usePoll, useProtocol, useTx } from '../lib/hooks';
import {
    AIRDROP_MAX, ARTIFACTS, artifactPrice, claimAirdrop, DYNAMIC_PRICE, nextArtifactPrice, claimArtifactChips, fetchArtifactsReady, fetchMyArtifacts, forgeArtifact, FORGE_SPLIT,
    P, PDA, recycleArtifact, SECONDARY_ROYALTY_PCT, WEEK_SECONDS,
} from '../lib/protocol';
import { AddrLink, Notice, Row, TxStatus, Xnt } from '../components/ui';
import lunarPreview from '../assets/nft/lunar_dust_preview.jpg';
import cosmicPreview from '../assets/nft/cosmic_shard_preview.jpg';
import solarPreview from '../assets/nft/solar_core_preview.jpg';
import voidPreview from '../assets/nft/void_anomaly_preview.jpg';

const PREVIEWS = [lunarPreview, cosmicPreview, solarPreview, voidPreview];
const VARIANT_IMAGES = import.meta.glob('../assets/nft/*/*.jpg', { eager: true, import: 'default' }) as Record<string, string>;
const variantsOf = (slug: string) => Object.entries(VARIANT_IMAGES).filter(([k]) => k.includes(`/nft/${slug}/`)).map(([k, v]) => ({ name: k.split('/').pop()!.replace('.jpg', '').replace(/_/g, ' '), src: v }));

export default function ArtifactsPage() {
    const { x1Provider, x1Address, x1Connected, connectX1, isConnecting } = useWallet();
    const proto = useProtocol(30_000);
    const ready = usePoll(() => fetchArtifactsReady(), [], 120_000);
    const owner = x1Connected && x1Address ? new PublicKey(x1Address) : null;
    const mine = usePoll(() => (owner ? fetchMyArtifacts(owner) : Promise.resolve(null)), [x1Address, x1Connected], 60_000);
    const tx = useTx();
    const now = useNow(30_000);
    const [confirmRecycle, setConfirmRecycle] = useState<string | null>(null);

    const cfg = proto.data?.config;
    const alive: number[] | null = cfg ? (cfg.artifactsAlive as number[]).map(Number) : null;
    const minted: number[] | null = cfg ? (cfg.artifactsMinted as number[]).map(Number) : null;
    const currentWeek = Math.floor(now / WEEK_SECONDS);
    const provider = x1Connected ? x1Provider : null;
    const canForge = !!provider && !!cfg && ready.data === true;

    const reload = () => { proto.reload(); mine.reload(); };

    return (
        <div className="max-w-6xl mx-auto">
            <div className="text-center mb-8">
                <h1 className="font-space text-4xl font-bold mb-2"><Gem className="inline w-8 h-8 text-forge-gold mr-2" />Artifacts</h1>
                <p className="text-lunar-400 max-w-3xl mx-auto">
                    Metaplex Core NFTs minted by the Moon Forge program. Each one can boost its holder's burn score, grants weekly lottery chips,
                    is a ticket to the Artifact Duel arena, and may hold an XNT floor you get back when you recycle it (forged: half of the price paid;
                    Lunar Dust from a Forge Drop: the drop value, ≥ {P.dropBackingXnt} XNT; Genesis airdrop: none).
                    Lunar Dust has a fixed price of {ARTIFACTS[0].price} XNT; the rarer tiers rise 5% with every forge and fall ÷1.05 (−4.76%) for every full week
                    without a forge, never below the base price and never above 100× base.
                </p>
            </div>

            {proto.error && <Notice kind="warn" className="mb-4">Live data unavailable: {proto.error}</Notice>}
            {cfg && ready.data === false && (
                <Notice kind="warn" className="mb-4">The Artifacts collection has not been created on X1 yet (permissionless <code>init_artifacts</code>). Forging opens once it exists.</Notice>
            )}
            {!x1Connected && (
                <div className="glass-card text-center mb-6">
                    <p className="text-lunar-300 mb-3">Connect your X1 wallet to forge, claim chips or recycle.</p>
                    <button onClick={connectX1} disabled={isConnecting} className="btn-forge">{isConnecting ? 'Connecting…' : 'Connect X1 Wallet'}</button>
                </div>
            )}

            <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />

            {/* Tiers */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 my-6">
                {ARTIFACTS.map((a) => {
                    const priceL = artifactPrice(cfg, a.tier, now);
                    const price = Number(priceL) / 1e9;
                    const nextP = Number(nextArtifactPrice(priceL, a.tier)) / 1e9;
                    const floor = (price * FORGE_SPLIT.floorPct) / 100;
                    const soldOut = alive ? alive[a.tier] >= a.supply : false;
                    const fmt = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 4 });
                    return (
                        <div key={a.tier} className="glass-card !p-4 flex flex-col">
                            <img src={PREVIEWS[a.tier]} alt={a.name} className="w-full aspect-square object-cover rounded-xl mb-3 border border-white/10" />
                            <div className="flex items-center justify-between mb-2">
                                <h3 className="font-space text-lg" style={{ color: a.color === '#3a1f5c' ? '#c084fc' : a.color }}>{a.name}</h3>
                                <span className="text-xs text-lunar-400">{a.element}</span>
                            </div>
                            <div className="text-sm flex-1">
                                <Row label="Price now">{cfg ? `${fmt(price)} XNT` : DYNAMIC_PRICE[a.tier] ? `from ${a.price} XNT (base)` : `${a.price} XNT`}</Row>
                                <Row label="Pricing">{DYNAMIC_PRICE[a.tier] ? <>base {a.price} XNT{cfg && <> · next buyer {fmt(nextP)} XNT</>}</> : 'fixed'}</Row>
                                <Row label="Alive / max supply">{alive ? `${alive[a.tier]} / ${a.supply}` : `-- / ${a.supply}`}</Row>
                                <Row label="Ever forged">{minted ? minted[a.tier] : '--'}</Row>
                                <Row label="Burn score boost">+{a.boostPct}%</Row>
                                <Row label="Weekly lottery chips">{a.weeklyChips}</Row>
                                <Row label="Floor if forged now">{cfg ? `${fmt(floor)} XNT (back on recycle)` : 'half of the price paid'}</Row>
                                <Row label="Artifact Duel">ticket to the arena (element chosen freely)</Row>
                            </div>
                            <button className="btn-forge w-full mt-3 !py-2" disabled={!canForge || soldOut || !!tx.busy}
                                onClick={() => provider && tx.run(`Forging ${a.name} for at most ${fmt(price)} XNT`, () => forgeArtifact(provider, a.tier, priceL), reload)}>
                                {soldOut ? 'All alive — recycle frees slots' : `Forge for ${fmt(price)} XNT`}
                            </button>
                        </div>
                    );
                })}
            </div>

            {/* Split */}
            <div className="glass-card mb-6">
                <h2 className="font-space text-xl mb-3">Where the forge price goes</h2>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
                    {[
                        { pct: FORGE_SPLIT.floorPct, label: 'Floor kept inside the NFT', sub: 'returned to you on recycle' },
                        { pct: FORGE_SPLIT.poolPct, label: 'Reward pool', sub: 'paid to burners' },
                        { pct: FORGE_SPLIT.drawPct, label: 'Burn Lottery vault', sub: 'weekly prize' },
                        { pct: FORGE_SPLIT.architectPct, label: 'Architect', sub: 'forge cut of the price paid' },
                    ].map((s) => (
                        <div key={s.label} className="bg-space-700/40 rounded-xl p-3">
                            <div className="font-space text-2xl text-forge-gold">{s.pct}%</div>
                            <div className="text-sm text-white">{s.label}</div>
                            <div className="text-xs text-lunar-400">{s.sub}</div>
                        </div>
                    ))}
                </div>
                <p className="text-xs text-lunar-500 mt-3">
                    Supply is a cap on Artifacts <em>alive</em> at the same time: recycling one returns its floor and frees its slot (it does not change the price),
                    and the next forge pays the split again. You sign the price you see as your maximum: if someone forges first and the price rises, your
                    transaction fails instead of charging more. Floors by origin: forged = half of what its buyer paid; Lunar Dust from a Forge Drop = the drop
                    value (≥ {P.dropBackingXnt} XNT); Genesis airdrop = none. The floor is written on-chain ("Floor XNT").
                    The boost only shifts shares between burners of the same epoch: it never raises the epoch total, and a burner alone gains nothing from it.
                    It counts only for an Artifact held by the same owner at both the previous and the current epoch snapshot (no flash forging or renting for
                    the snapshot), and only the best one per wallet counts.
                </p>
            </div>

            {/* Mine */}
            {owner && (
                <div className="glass-card mb-6">
                    <h2 className="font-space text-xl mb-3">My Artifacts</h2>
                    {mine.error && <Notice kind="error">{mine.error}</Notice>}
                    {mine.data && mine.data.length === 0 && <p className="text-sm text-lunar-400">This wallet holds no Moon Forge Artifact.</p>}
                    {!mine.data && mine.loading && <p className="text-sm text-lunar-400">Reading…</p>}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {(mine.data ?? []).map((m) => {
                            const t = ARTIFACTS[m.tier];
                            const key = m.asset.toBase58();
                            const chipsReady = m.lastChipWeek < currentWeek;
                            return (
                                <div key={key} className="flex gap-3 bg-space-700/30 rounded-xl p-3">
                                    <img src={PREVIEWS[m.tier]} alt={t.name} className="w-24 h-24 object-cover rounded-lg border border-white/10" />
                                    <div className="flex-1 min-w-0 text-sm">
                                        <div className="font-space text-white">{t.name} #{m.serial + 1}</div>
                                        <div className="text-xs text-lunar-400">{m.origin === 1 ? 'Genesis airdrop' : m.origin === 2 ? 'Forge Drop' : 'Forged'} · <AddrLink address={m.asset} /></div>
                                        <div className="text-xs text-lunar-300 mt-1">Floor inside: <Xnt lamports={m.backing} /></div>
                                        <div className="flex flex-wrap gap-2 mt-2">
                                            <button className="btn-forge !px-3 !py-1 text-xs flex items-center gap-1" disabled={!provider || !chipsReady || !!tx.busy}
                                                onClick={() => provider && tx.run(`Claiming ${t.weeklyChips} chips`, () => claimArtifactChips(provider, m.asset), reload)}>
                                                <Ticket className="w-3 h-3" /> {chipsReady ? `Claim ${t.weeklyChips} chips` : 'Chips claimed this week'}
                                            </button>
                                            <button className="btn-outline !px-3 !py-1 text-xs flex items-center gap-1" disabled={!provider || !!tx.busy}
                                                onClick={() => setConfirmRecycle(confirmRecycle === key ? null : key)}>
                                                <Recycle className="w-3 h-3" /> Recycle…
                                            </button>
                                        </div>
                                        {confirmRecycle === key && (
                                            <div className="mt-2 p-2 rounded-lg border border-amber-500/40 bg-amber-500/5 text-xs">
                                                Burns this NFT and returns its floor <strong><Xnt lamports={m.backing} /></strong> plus the record's rent to your wallet.
                                                You lose its boost, weekly chips and Duel ticket.
                                                <div className="flex gap-2 mt-2">
                                                    <button className="px-3 py-1 rounded-lg bg-amber-500 text-space-900 font-bold" disabled={!!tx.busy}
                                                        onClick={() => provider && tx.run('Recycling', () => recycleArtifact(provider, m.asset), () => { setConfirmRecycle(null); reload(); })}>
                                                        Confirm recycle
                                                    </button>
                                                    <button className="text-lunar-400" onClick={() => setConfirmRecycle(null)}>Cancel</button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Airdrop + marketplace */}
            <div className="grid md:grid-cols-2 gap-6 mb-6">
                <div className="glass-card">
                    <div className="flex items-center gap-2 mb-3"><Gift className="w-5 h-5 text-forge-gold" /><h2 className="font-space text-xl">Genesis airdrop</h2></div>
                    <p className="text-sm text-lunar-400 mb-3">
                        Up to {AIRDROP_MAX} Lunar Dust with no purchase price and no floor inside, for wallets in a Merkle list. The current draft lists 444 validator
                        withdraw authorities and will be rebuilt to add Genesis supporters before the architect sets the root (one time, final; its only privileged
                        program action). Only the first {AIRDROP_MAX} claims succeed; the claimant pays the account rent and needs a free Lunar Dust slot.
                    </p>
                    <Row label="List published on-chain">{cfg ? (cfg.airdropRootSet ? 'yes' : 'not yet') : '--'}</Row>
                    <Row label="Claimed">{cfg ? `${Number(cfg.airdropClaimed)} / ${AIRDROP_MAX}` : '--'}</Row>
                    <button className="btn-forge w-full mt-3 !py-2" disabled={!provider || !cfg?.airdropRootSet || ready.data !== true || !!tx.busy}
                        onClick={() => provider && tx.run('Claiming the Genesis airdrop', () => claimAirdrop(provider), reload)}>
                        Claim my Genesis Lunar Dust
                    </button>
                </div>
                <div className="glass-card">
                    <div className="flex items-center gap-2 mb-3"><Store className="w-5 h-5 text-forge-gold" /><h2 className="font-space text-xl">Trading</h2></div>
                    <p className="text-sm text-lunar-400">
                        Artifacts are standard Metaplex Core assets in the "Moon Forge Artifacts" collection, so they can be traded on any Metaplex Core
                        marketplace that supports X1. A {SECONDARY_ROYALTY_PCT}% royalty to the architect is declared on the collection (paid only where the
                        marketplace honors Core royalties). Moon Forge runs no marketplace and shows no listings.
                    </p>
                    <div className="text-xs text-lunar-400 mt-3">Collection: <AddrLink address={PDA.collection()} /></div>
                    <p className="text-xs text-lunar-500 mt-2">
                        Weekly chips follow the current holder: one claim per Artifact per week (1 chip = the weight of one {P.ticketPrice}-XNT lottery ticket); weeks reset
                        on Thursdays 00:00 UTC and missed weeks do not accumulate. The burn boost needs the same owner at two consecutive epoch snapshots, so a newly
                        bought Artifact boosts from its second snapshot on.
                    </p>
                </div>
            </div>

            {/* Gallery */}
            <div className="glass-card">
                <h2 className="font-space text-xl mb-3">Artwork variants</h2>
                {ARTIFACTS.map((a) => (
                    <div key={a.slug} className="mb-4">
                        <div className="text-sm text-lunar-300 mb-2">{a.name} — {a.variants} variant{a.variants > 1 ? 's' : ''}</div>
                        <div className="flex flex-wrap gap-2">
                            {variantsOf(a.slug).map((v) => (
                                <figure key={v.src} className="w-24">
                                    <img src={v.src} alt={v.name} className="w-24 h-24 object-cover rounded-lg border border-white/10" loading="lazy" />
                                    <figcaption className="text-[10px] text-lunar-500 text-center capitalize mt-1">{v.name}</figcaption>
                                </figure>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
