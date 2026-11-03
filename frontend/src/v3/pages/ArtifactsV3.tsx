/**
 * Artifacts page AFTER THE FINAL UPGRADE (rendered by pages/ArtifactsPage.tsx only when rules detection reads 3).
 * PX prices read from Config, the two-pot split, forge / recycle with the new accounts, the native market
 * (list / update / delist / buy / close), Genesis. No chips, no boost, no ticket.
 */
import { useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { Gem, Recycle, Gift, Store, Tag } from 'lucide-react';
import { useWallet } from '../../context/WalletContext';
import { useNow, usePoll, useProtocol, useTx } from '../../lib/hooks';
import { AIRDROP_MAX, ARTIFACTS, claimAirdrop, fetchArtifactsReady, fetchMyArtifacts, PDA, readConnection } from '../../lib/protocol';
import { formatDuration } from '../../lib/constants';
import { AddrLink, Notice, Row, TxStatus, Xnt } from '../../components/ui';
import { readRules } from '../detect';
import { currentPrice, forgeSplit, minPrice, nextDecayIn, nextPrice } from '../px';
import { AIRDROP_DEADLINE, ARTIFACT_SUPPLY, MARKET_MAX_LISTING_SECONDS, ORIGIN_DROP, ORIGIN_GENESIS } from '../constants';
import { buyArtifactV3, closeListingV3, delistArtifactV3, fetchListings, forgeArtifactV3, listArtifactV3, recycleArtifactV3, updateListingV3, validateListing } from '../actions';
import { marketSplit, MARKET_FEES_LINE, minListPriceForFloor } from '../market';
import { artifactRulesS7, forgeSplitS7 } from '../facts-s7';
import TwoPotCard from '../ui/TwoPotCard';
import { CORE_CLOSED_NOTICE, readCoreClosed } from '../core-hatch';
import type { ListingView } from '../layout';
import lunarPreview from '../../assets/nft/lunar_dust_preview.jpg';
import cosmicPreview from '../../assets/nft/cosmic_shard_preview.jpg';
import solarPreview from '../../assets/nft/solar_core_preview.jpg';
import voidPreview from '../../assets/nft/void_anomaly_preview.jpg';

const PREVIEWS = [lunarPreview, cosmicPreview, solarPreview, voidPreview];
const fmt = (l: bigint | number) => (Number(l) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 4 });
const toLamports = (s: string): bigint | null => {
    const t = s.trim().replace(',', '.');
    if (!/^\d+(\.\d{0,9})?$/.test(t)) return null;
    const [i, f = ''] = t.split('.');
    return BigInt(i) * 1_000_000_000n + BigInt((f + '000000000').slice(0, 9));
};

export default function ArtifactsV3() {
    const { x1Provider, x1Address, x1Connected, connectX1, isConnecting } = useWallet();
    const proto = useProtocol(30_000);
    const ready = usePoll(() => fetchArtifactsReady(), [], 120_000);
    const extra = usePoll(() => readRules().then((r) => r.extraState), [], 60_000);
    // r9 hatch: Metaplex Core closed on X1 (its program still under the upgradeable loader, its ProgramData gone)
    const coreClosed = usePoll(() => readCoreClosed(readConnection), [], 300_000);
    const owner = x1Connected && x1Address ? new PublicKey(x1Address) : null;
    const mine = usePoll(() => (owner ? fetchMyArtifacts(owner) : Promise.resolve(null)), [x1Address, x1Connected], 60_000);
    const listings = usePoll(() => fetchListings(), [], 60_000);
    const airdropList = usePoll(async () => {
        const r = await fetch(`${import.meta.env.BASE_URL}airdrop/airdrop.json`, { cache: 'no-store' });
        if (!r.ok) return [] as string[];
        const j = await r.json();
        return (Array.isArray(j.wallets) ? j.wallets : Object.keys(j.proofs ?? {})) as string[];
    }, [], 600_000);
    const tx = useTx();
    const now = useNow(15_000);
    const [confirmRecycle, setConfirmRecycle] = useState<string | null>(null);
    const [confirmForge, setConfirmForge] = useState<number | null>(null);

    const cfg = proto.data?.config;
    const alive: number[] | null = cfg ? (cfg.artifactsAlive as number[]).map(Number) : null;
    const minted: number[] | null = cfg ? (cfg.artifactsMinted as number[]).map(Number) : null;
    const provider = x1Connected ? x1Provider : null;
    const canForge = !!provider && !!cfg && ready.data === true;
    const reload = () => { proto.reload(); mine.reload(); listings.reload(); extra.reload(); };
    const myListings = new Map((listings.data ?? []).filter((l) => owner && l.listing.seller.equals(owner)).map((l) => [l.listing.asset.toBase58(), l.listing]));

    return (
        <div className="max-w-6xl mx-auto">
            <div className="text-center mb-8">
                <h1 className="font-space text-4xl font-bold mb-2"><Gem className="inline w-8 h-8 text-forge-gold mr-2" />Artifacts</h1>
                <p className="text-lunar-400 max-w-3xl mx-auto">
                    Metaplex Core NFTs minted by the Moon Forge program. {artifactRulesS7.split} {artifactRulesS7.noTicket}
                </p>
            </div>

            {proto.error && <Notice kind="warn" className="mb-4">Live data unavailable: {proto.error}</Notice>}
            {coreClosed.data === true && <Notice kind="warn" className="mb-4">{CORE_CLOSED_NOTICE}</Notice>}
            {cfg && ready.data === false && <Notice kind="warn" className="mb-4">The Artifacts collection does not exist on X1 yet: forging opens once it does.</Notice>}
            {!x1Connected && (
                <div className="glass-card text-center mb-6">
                    <p className="text-lunar-300 mb-3">Connect your X1 wallet to forge, recycle, list or buy.</p>
                    <button onClick={connectX1} disabled={isConnecting} className="btn-forge">{isConnecting ? 'Connecting…' : 'Connect X1 Wallet'}</button>
                </div>
            )}
            <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />

            <TwoPotCard rewardFree={proto.data ? proto.data.rewardFree : null} extra={extra.data ?? null} />

            {/* Tiers: PX price read from Config */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 my-6">
                {ARTIFACTS.map((a) => {
                    const t = a.tier;
                    const price = cfg ? currentPrice(cfg, t, now) : null;
                    const split = price !== null ? forgeSplit(price) : null;
                    const decayIn = cfg ? nextDecayIn(cfg, t, now) : null;
                    const soldOut = alive ? alive[t] >= ARTIFACT_SUPPLY[t] : false;
                    return (
                        <div key={t} className="glass-card !p-4 flex flex-col">
                            <img src={PREVIEWS[t]} alt={a.name} className="w-full aspect-square object-cover rounded-xl mb-3 border border-white/10" />
                            <div className="flex items-center justify-between mb-2">
                                <h3 className="font-space text-lg" style={{ color: a.color === '#3a1f5c' ? '#c084fc' : a.color }}>{a.name}</h3>
                                <span className="text-xs text-lunar-400">{a.element}</span>
                            </div>
                            <div className="text-sm flex-1">
                                <Row label="Price now">{price !== null ? `${fmt(price)} XNT` : '--'}</Row>
                                <Row label="Next buyer pays">{price !== null ? `${fmt(nextPrice(price, t))} XNT` : '--'}</Row>
                                <Row label="Lowest price">{fmt(minPrice(t))} XNT</Row>
                                <Row label="Next price step down">{soldOut ? 'tier full: no decay' : decayIn !== null ? `in ${formatDuration(decayIn)}` : 'at its lowest'}</Row>
                                <Row label="Alive / max supply">{alive ? `${alive[t]} / ${ARTIFACT_SUPPLY[t]}` : `-- / ${ARTIFACT_SUPPLY[t]}`}</Row>
                                <Row label="Ever minted">{minted ? minted[t] : '--'}</Row>
                                <Row label="Floor if forged now">{split ? `${fmt(split.backing)} XNT (back on recycle)` : 'half of the price paid'}</Row>
                                {split && <Row label="To base / extra pot">{fmt(split.toPool)} / {fmt(split.toExtra)} XNT</Row>}
                            </div>
                            {confirmForge === t && price !== null ? (
                                <div className="mt-3 p-2 rounded-lg border border-forge-orange/50 bg-forge-orange/5 text-xs">
                                    You sign {fmt(price)} XNT as your maximum: if the price moved, the transaction fails instead of charging more. The floor ({fmt(split!.backing)} XNT)
                                    stays inside the Artifact; {forgeSplitS7.basePotPct}% goes to the base pot, {forgeSplitS7.extraPotPct}% to the extra pot, {forgeSplitS7.architectPct}% to the architect. {artifactRulesS7.walletBurn}
                                    <div className="flex gap-2 mt-2">
                                        <button className="btn-forge !px-3 !py-1 text-xs" disabled={!canForge || soldOut || !!tx.busy}
                                            onClick={() => provider && tx.run(`Forging ${a.name} for at most ${fmt(price)} XNT`, () => forgeArtifactV3(provider, t, price), () => { setConfirmForge(null); reload(); })}>
                                            Confirm forge
                                        </button>
                                        <button className="text-lunar-400" onClick={() => setConfirmForge(null)}>Cancel</button>
                                    </div>
                                </div>
                            ) : (
                                <button className="btn-forge w-full mt-3 !py-2" disabled={!canForge || soldOut || price === null || !!tx.busy} onClick={() => setConfirmForge(t)}>
                                    {soldOut ? 'All alive: a recycle frees a slot' : price !== null ? `Forge for ${fmt(price)} XNT` : 'Forge'}
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
            <div className="glass-card mb-6 text-xs text-lunar-400 space-y-2">
                <p>{artifactRulesS7.pricing}</p>
                <p>{artifactRulesS7.floors}</p>
            </div>

            {/* Mine */}
            {owner && (
                <div className="glass-card mb-6">
                    <h2 className="font-space text-xl mb-3">My Artifacts</h2>
                    {mine.error && <Notice kind="error">Could not load your Artifacts: {mine.error}</Notice>}
                    {mine.data && mine.data.length === 0 && <p className="text-sm text-lunar-400">This wallet holds no Moon Forge Artifact.</p>}
                    {!mine.data && mine.loading && <p className="text-sm text-lunar-400">Reading…</p>}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {(mine.data ?? []).map((m) => {
                            const t = ARTIFACTS[m.tier];
                            const key = m.asset.toBase58();
                            const listed = myListings.get(key) ?? null;
                            return (
                                <div key={key} className="flex gap-3 bg-space-700/30 rounded-xl p-3">
                                    <img src={PREVIEWS[m.tier]} alt={t.name} className="w-24 h-24 object-cover rounded-lg border border-white/10" />
                                    <div className="flex-1 min-w-0 text-sm">
                                        <div className="font-space text-white">{t.name} #{m.serial + 1}</div>
                                        <div className="text-xs text-lunar-400">{m.origin === ORIGIN_GENESIS ? 'Genesis airdrop' : m.origin === ORIGIN_DROP ? 'Forge Drop' : 'Forged'} · <AddrLink address={m.asset} /></div>
                                        <div className="text-xs text-lunar-300 mt-1">Floor inside: <Xnt lamports={m.backing} /></div>
                                        {listed && <div className="text-xs text-forge-gold mt-1">Listed at {fmt(listed.price)} XNT, until {new Date(Number(listed.expiresAt) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC</div>}
                                        <div className="flex flex-wrap gap-2 mt-2">
                                            <button className="btn-outline !px-3 !py-1 text-xs flex items-center gap-1" disabled={!provider || !!tx.busy || !!listed}
                                                title={listed ? 'Delist it first' : undefined}
                                                onClick={() => setConfirmRecycle(confirmRecycle === key ? null : key)}>
                                                <Recycle className="w-3 h-3" /> Recycle…
                                            </button>
                                        </div>
                                        {confirmRecycle === key && (
                                            <div className="mt-2 p-2 rounded-lg border border-amber-500/40 bg-amber-500/5 text-xs">
                                                Burns this NFT and gives back its floor <strong><Xnt lamports={m.backing} /></strong> plus the record's rent to your wallet.
                                                {m.origin === ORIGIN_GENESIS && <> A Genesis Lunar Dust has no floor: recycling it gives back only the record's rent.</>}
                                                <div className="flex gap-2 mt-2">
                                                    <button className="px-3 py-1 rounded-lg bg-amber-500 text-space-900 font-bold" disabled={!!tx.busy}
                                                        onClick={() => provider && tx.run('Recycling', () => recycleArtifactV3(provider, m.asset), () => { setConfirmRecycle(null); reload(); })}>
                                                        Confirm recycle
                                                    </button>
                                                    <button className="text-lunar-400" onClick={() => setConfirmRecycle(null)}>Cancel</button>
                                                </div>
                                            </div>
                                        )}
                                        {provider && <SellBox asset={m.asset} backing={BigInt(m.backing)} listed={listed} busy={!!tx.busy} now={now}
                                            onList={(price, exp, buyer) => tx.run(listed ? 'Updating the listing' : 'Listing', () => (listed ? updateListingV3(provider, m.asset, price, exp, buyer) : listArtifactV3(provider, m.asset, price, exp, buyer)), reload)}
                                            onDelist={() => tx.run('Delisting', () => delistArtifactV3(provider, m.asset), reload)} />}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Market */}
            <MarketList listings={listings.data} error={listings.error} loading={listings.loading} owner={owner} now={now} busy={!!tx.busy}
                onBuy={(l) => provider && tx.run(`Buying for ${fmt(l.price)} XNT`, () => buyArtifactV3(provider, l), reload)}
                onClose={(l) => provider && tx.run('Closing the listing (rent back to the seller)', () => closeListingV3(provider, l), reload)} />

            {/* Genesis */}
            <div className="glass-card mb-6">
                <div className="flex items-center gap-2 mb-3"><Gift className="w-5 h-5 text-forge-gold" /><h2 className="font-space text-xl">Genesis airdrop</h2></div>
                <p className="text-sm text-lunar-400 mb-3">
                    Up to {AIRDROP_MAX} Lunar Dust for the X1 validator withdraw authorities published on-chain on 2026-10-12, first come first served, until
                    {' '}{new Date(AIRDROP_DEADLINE * 1000).toISOString().slice(0, 10)} 00:00 UTC. {artifactRulesS7.genesis}
                </p>
                <Row label="Claimed">{cfg ? `${Number(cfg.airdropClaimed)} / ${AIRDROP_MAX}` : '--'}</Row>
                <Row label="Your connected X1 wallet">{!owner ? 'connect to check' : airdropList.data ? (airdropList.data.includes(owner.toBase58()) ? <span className="text-green-400">on the list</span> : 'not on the list') : '--'}</Row>
                <button className="btn-forge w-full mt-3 !py-2" disabled={!provider || !cfg?.airdropRootSet || ready.data !== true || now >= AIRDROP_DEADLINE || !!tx.busy}
                    onClick={() => provider && tx.run('Claiming the Genesis airdrop', () => claimAirdrop(provider), reload)}>
                    Claim my Genesis Lunar Dust
                </button>
            </div>

            <div className="glass-card text-xs text-lunar-500">
                Genuine Artifacts are Metaplex Core assets of the collection <AddrLink address={PDA.collection()} full /> whose ArtifactRecord exists under the Moon Forge
                program; anything else is not a Moon Forge Artifact. {artifactRulesS7.walletBurn}
            </div>
        </div>
    );
}

function SellBox({ asset, backing, listed, busy, now, onList, onDelist }: {
    asset: PublicKey; backing: bigint; listed: ListingView | null; busy: boolean; now: number;
    onList: (price: bigint, expiresAt: number, reservedBuyer: PublicKey | null) => void; onDelist: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [price, setPrice] = useState(listed ? String(Number(listed.price) / 1e9) : '');
    const [days, setDays] = useState('30');
    const [buyer, setBuyer] = useState('');
    const lam = toLamports(price);
    const d = Math.floor(Number(days));
    const exp = now + Math.max(1, Math.min(90, d || 0)) * 86_400;
    let reserved: PublicKey | null = null;
    let buyerErr: string | null = null;
    if (buyer.trim()) { try { reserved = new PublicKey(buyer.trim()); } catch { buyerErr = 'Not a valid X1 address'; } }
    const err = lam === null ? (price ? 'Enter a price in XNT' : null) : validateListing(lam, backing, Math.min(exp, now + MARKET_MAX_LISTING_SECONDS), now);
    const s = lam !== null ? marketSplit(lam) : null;
    if (!open) {
        return (
            <div className="flex flex-wrap gap-2 mt-2">
                <button className="btn-outline !px-3 !py-1 text-xs flex items-center gap-1" disabled={busy} onClick={() => setOpen(true)}><Tag className="w-3 h-3" /> {listed ? 'Change listing…' : 'Sell…'}</button>
                {listed && <button className="btn-outline !px-3 !py-1 text-xs" disabled={busy} onClick={onDelist}>Delist</button>}
            </div>
        );
    }
    return (
        <div className="mt-2 p-2 rounded-lg border border-white/10 bg-space-700/40 text-xs space-y-2">
            <div className="grid grid-cols-2 gap-2">
                <label>Price (XNT)<input className="input-forge !py-1 mt-1" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
                <label>Expires in (days, max 90)<input className="input-forge !py-1 mt-1" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} /></label>
            </div>
            <label className="block">Reserve for one buyer (optional X1 address)<input className="input-forge !py-1 mt-1 font-mono" value={buyer} onChange={(e) => setBuyer(e.target.value)} /></label>
            {buyerErr && <p className="text-red-400">{buyerErr}</p>}
            <p className="text-lunar-400">Lowest price that still gives you this Artifact’s floor: {fmt(minListPriceForFloor(backing))} XNT.</p>
            {s && <p className="text-lunar-300">A sale at {fmt(lam!)} XNT pays you {fmt(s.sellerNet)} XNT; {fmt(s.royalty)} XNT royalty to the architect; {fmt(s.poolFee)} XNT to the base pot; nothing to the extra pot.</p>}
            {err && <p className="text-amber-400">{err}</p>}
            <p className="text-lunar-500">{MARKET_FEES_LINE} The Artifact stays in your wallet; selling or moving it elsewhere ends the listing.</p>
            <div className="flex gap-2">
                <button className="btn-forge !px-3 !py-1 text-xs" disabled={busy || lam === null || !!err || !!buyerErr} onClick={() => lam !== null && onList(lam, exp, reserved)}>{listed ? 'Update listing' : 'List'}</button>
                <button className="text-lunar-400" onClick={() => setOpen(false)}>Cancel</button>
            </div>
        </div>
    );
}

function MarketList({ listings, error, loading, owner, now, busy, onBuy, onClose }: {
    listings: { pubkey: PublicKey; listing: ListingView }[] | null; error: string | null; loading: boolean; owner: PublicKey | null; now: number; busy: boolean;
    onBuy: (l: ListingView) => void; onClose: (l: ListingView) => void;
}) {
    const [confirm, setConfirm] = useState<string | null>(null);
    const assets = (listings ?? []).map((l) => l.listing.asset);
    // holder check of every listed asset (stale listings can be closed by anyone; rent goes back to the seller)
    const holders = usePoll(async () => {
        const out = new Map<string, string | null>();
        for (let i = 0; i < assets.length; i += 100) {
            const infos = await readConnection.getMultipleAccountsInfo(assets.slice(i, i + 100));
            infos.forEach((info, k) => out.set(assets[i + k].toBase58(), info && info.data.length >= 33 && info.data[0] === 1 ? new PublicKey(info.data.subarray(1, 33)).toBase58() : null));
        }
        return out;
    }, [assets.map((a) => a.toBase58()).join(',')], 0);
    const rows = (listings ?? []).map((x) => x.listing).sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
    return (
        <div className="glass-card mb-6">
            <div className="flex items-center gap-2 mb-3"><Store className="w-5 h-5 text-forge-gold" /><h2 className="font-space text-xl">Market</h2></div>
            <p className="text-sm text-lunar-400 mb-3">{artifactRulesS7.trading} {artifactRulesS7.marketLimits}</p>
            {error && <Notice kind="error">Could not load the listings: {error}</Notice>}
            {!listings && loading && <p className="text-sm text-lunar-400">Reading listings…</p>}
            {listings && rows.length === 0 && <p className="text-sm text-lunar-400">No Artifact is listed right now.</p>}
            {rows.length > 0 && (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead><tr className="text-left text-lunar-400 border-b border-white/10"><th className="py-2 pr-3">Artifact</th><th className="py-2 pr-3">Price</th><th className="py-2 pr-3">Seller receives</th><th className="py-2 pr-3">Expires</th><th className="py-2">Action</th></tr></thead>
                        <tbody>
                            {rows.map((l) => {
                                const k = l.asset.toBase58();
                                const s = marketSplit(l.price);
                                const expired = now >= Number(l.expiresAt);
                                const holder = holders.data?.get(k);
                                const stale = holders.data ? holder !== l.seller.toBase58() : false;
                                const reservedOther = !l.reservedBuyer.equals(PublicKey.default) && !(owner && l.reservedBuyer.equals(owner));
                                const isMine = !!owner && l.seller.equals(owner);
                                return (
                                    <tr key={k} className="border-b border-white/5 align-top">
                                        <td className="py-2 pr-3">{ARTIFACTS[l.tier]?.name ?? `tier ${l.tier}`} · <AddrLink address={l.asset} /></td>
                                        <td className="py-2 pr-3">{fmt(l.price)} XNT</td>
                                        <td className="py-2 pr-3 text-xs">{fmt(s.sellerNet)} XNT (royalty {fmt(s.royalty)}, base pot {fmt(s.poolFee)})</td>
                                        <td className="py-2 pr-3 text-xs">{expired ? 'expired' : formatDuration(Number(l.expiresAt) - now)}</td>
                                        <td className="py-2 text-xs">
                                            {expired || stale ? (
                                                <button className="btn-outline !px-2 !py-1 text-xs" disabled={!owner || busy} onClick={() => onClose(l)}>Close ({expired ? 'expired' : 'seller no longer holds it'})</button>
                                            ) : isMine ? <span className="text-lunar-400">your listing</span>
                                                : reservedOther ? <span className="text-lunar-500">reserved for another buyer</span>
                                                    : confirm === k ? (
                                                        <span className="flex flex-col gap-1">
                                                            <span>You pay exactly {fmt(l.price)} XNT; if the seller changed the price the transaction fails.</span>
                                                            <span className="flex gap-2">
                                                                <button className="btn-forge !px-2 !py-1 text-xs" disabled={!owner || busy} onClick={() => { setConfirm(null); onBuy(l); }}>Confirm buy</button>
                                                                <button className="text-lunar-400" onClick={() => setConfirm(null)}>Cancel</button>
                                                            </span>
                                                        </span>
                                                    ) : <button className="btn-forge !px-2 !py-1 text-xs" disabled={!owner || busy} onClick={() => setConfirm(k)}>Buy…</button>}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
            <p className="text-xs text-lunar-500 mt-3">{MARKET_FEES_LINE}</p>
        </div>
    );
}
