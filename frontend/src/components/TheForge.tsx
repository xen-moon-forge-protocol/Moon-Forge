/**
 * The Forge — burn XEN on an EVM chain through MoonForgePortal v2.
 *
 * Flow: pick chain (only chains with a deployed portal) → amount → tier → X1 destination
 * → network check / switch → exact-amount approve (if needed) → enterForge.
 * Success is shown ONLY when the receipt contains the portal's MissionStarted event.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ethers } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { Flame, ArrowRight, Loader2 } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import { CHAINS, EVM_CHAINS, isPortalDeployed, formatNumber, PROJECT_LINKS } from '../lib/constants';
import { burnXen, errorMessage, P, parseMissionStarted, x1ToBytes32, xenBalanceOf } from '../lib/protocol';
import { EvmTxLink, Notice, Row } from './ui';
import BurnVsSell from './ROICalculator';
import FairValueEngine from './FairValueEngine';
import { useProtocol } from '../lib/hooks';

/** Below this free reward pool the UI warns burners that the next epoch can pay little. */
const LOW_POOL_XNT = 100;

type Step = 'idle' | 'switching' | 'approve' | 'burn' | 'done';

export default function TheForge() {
    const { evmAddress, evmChainId, connectEVM, switchChain, x1Address, x1Connected, connectX1 } = useWallet();

    const deployedChains = EVM_CHAINS.filter((k) => isPortalDeployed(k));
    const [chainKey, setChainKey] = useState<string>(deployedChains[0] ?? 'ethereum');
    const chain = CHAINS[chainKey];
    const portalReady = isPortalDeployed(chainKey);

    const [amount, setAmount] = useState('');
    const [tier, setTier] = useState(0);
    const [dest, setDest] = useState('');
    const [destTouched, setDestTouched] = useState(false);
    const [ack, setAck] = useState(false);

    const [balance, setBalance] = useState<bigint | null>(null);
    const [step, setStep] = useState<Step>('idle');
    const [approveHash, setApproveHash] = useState<string | null>(null);
    const [burnHash, setBurnHash] = useState<string | null>(null);
    const [result, setResult] = useState<ReturnType<typeof parseMissionStarted>>(null);
    const [error, setError] = useState<string | null>(null);

    // Prefill the destination once from the connected X1 wallet (never overwrite what the user typed).
    useEffect(() => {
        if (x1Address && !destTouched) setDest(x1Address);
    }, [x1Address, destTouched]);

    // XEN balance on the SELECTED chain (read-only RPC, independent of MetaMask's current network).
    useEffect(() => {
        let alive = true;
        setBalance(null);
        if (!evmAddress) return;
        const rpc = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
        xenBalanceOf(rpc, chain.xenToken, evmAddress)
            .then((b) => { if (alive) setBalance(b); })
            .catch(() => { if (alive) setBalance(null); });
        return () => { alive = false; };
    }, [evmAddress, chainKey, step === 'done']); // eslint-disable-line react-hooks/exhaustive-deps

    const amountWei = useMemo(() => {
        try {
            const s = amount.trim().replace(/,/g, '');
            if (!s) return null;
            const v = ethers.parseUnits(s, 18);
            return v > 0n ? v : null;
        } catch {
            return null;
        }
    }, [amount]);

    const destCheck = useMemo(() => {
        if (!dest.trim()) return { ok: false, msg: null as string | null, warn: null as string | null };
        try {
            x1ToBytes32(dest);
            const pk = new PublicKey(dest.trim());
            const warn = !PublicKey.isOnCurve(pk.toBytes())
                ? 'This is not a regular wallet key (off-curve / program address). It could receive XNT but never sign ejects or games.'
                : x1Address && pk.toBase58() !== x1Address
                    ? 'This differs from your connected X1 wallet. XNT will go to the address above.'
                    : null;
            return { ok: true, msg: null, warn };
        } catch (e: any) {
            return { ok: false, msg: e?.message || 'Invalid X1 address', warn: null };
        }
    }, [dest, x1Address]);

    const overBalance = balance !== null && amountWei !== null && amountWei > balance;
    const wrongNetwork = !!evmAddress && evmChainId !== chain.chainId;
    const busy = step === 'switching' || step === 'approve' || step === 'burn';
    const canBurn = !!evmAddress && portalReady && amountWei !== null && !overBalance && destCheck.ok && ack && !busy;

    const handleBurn = async () => {
        if (!amountWei || !window.ethereum) return;
        setError(null);
        setApproveHash(null);
        setBurnHash(null);
        setResult(null);
        try {
            // 1. make sure the wallet is on the selected chain, then build a fresh signer bound to it
            let provider = new ethers.BrowserProvider(window.ethereum);
            let net = await provider.getNetwork();
            if (Number(net.chainId) !== chain.chainId) {
                setStep('switching');
                await switchChain(chain.chainId);
                provider = new ethers.BrowserProvider(window.ethereum);
                net = await provider.getNetwork();
                if (Number(net.chainId) !== chain.chainId) throw new Error(`Your wallet is still on chain ${net.chainId}. Switch to ${chain.name} and retry.`);
            }
            const signer = await provider.getSigner();

            // 2. exact-amount approve (only if needed) + enterForge
            const receipt = await burnXen(signer, chain.portalAddress, chain.xenToken, amountWei, tier, dest.trim(), (s, hash) => {
                setStep(s);
                if (hash) (s === 'approve' ? setApproveHash : setBurnHash)(hash);
            });
            if (!receipt || receipt.status !== 1) throw new Error('The burn transaction failed (reverted).');
            const ev = parseMissionStarted(receipt, chain.portalAddress);
            if (!ev) throw new Error('No MissionStarted event from the portal in this receipt: nothing was registered. Check the transaction on the explorer.');
            setBurnHash(receipt.hash);
            setResult(ev);
            setStep('done');
        } catch (e) {
            setError(errorMessage(e));
            setStep('idle');
        }
    };

    const reset = () => {
        setStep('idle');
        setAmount('');
        setAck(false);
        setResult(null);
        setApproveHash(null);
        setBurnHash(null);
        setError(null);
    };

    const tierInfo = P.tiers[tier];
    const { data: pool } = useProtocol(60_000);
    const poolLow = !!pool && pool.rewardFree < LOW_POOL_XNT * 1e9;

    return (
        <div className="max-w-6xl mx-auto">
            <div className="text-center mb-8">
                <h1 className="font-space text-4xl font-bold mb-2"><span className="text-forge-orange">🔥</span> The Forge</h1>
                <p className="text-lunar-400">Burn XEN on any supported chain. Receive XNT on X1. Zero protocol fees on this path.</p>
            </div>

            {deployedChains.length === 0 && (
                <Notice kind="warn" className="mb-6">
                    No MoonForgePortal v2 is deployed yet on any chain, so burning is disabled. Nothing can be burned from this page until a portal
                    address is published (see the <a href={PROJECT_LINKS.portal} target="_blank" rel="noopener noreferrer" className="underline">portal source</a>).
                </Notice>
            )}

            {poolLow && (
                <Notice kind="warn" className="mb-6">
                    The reward pool holds only {formatNumber(pool!.rewardFree / 1e9)} free XNT, so the next epoch can pay at most{' '}
                    {formatNumber(pool!.nextEpochBudget / 1e9)} XNT to all burners together. Burns are recorded and paid from each epoch's budget;
                    you may want to wait until the pool grows, or <a href={`${PROJECT_LINKS.github}/blob/main/docs/SUPPORT.md`} target="_blank" rel="noopener noreferrer" className="underline">help fund it</a>.
                </Notice>
            )}

            {pool && (
                <Notice kind="info" className="mb-6">
                    <strong>Forge Drops:</strong> up to {P.dropBudgetPct}% of each epoch budget (max {P.maxDropsPerEpoch * P.dropBackingXnt} XNT) is drawn
                    among that epoch's burners as Lunar Dust Artifacts whose floor is the drop value (at least {P.dropBackingXnt} XNT). Drops are part of
                    the budget, not extra, and are paid in XNT if Lunar Dust is sold out (next epoch: up to ≈ {formatNumber(pool.nextDropReserve / 1e9)} XNT
                    of drops). Your chance grows linearly with what you burn; a winner can recycle the Artifact for its floor at once or keep it for a
                    +5% share boost (it counts once held at two consecutive epoch snapshots), weekly lottery chips and entry to Artifact Duel and Moon Wars.
                </Notice>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 glass-card">
                    {step === 'done' && result ? (
                        <div className="text-center py-6">
                            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-500/20 flex items-center justify-center">
                                <Flame className="w-8 h-8 text-green-400" />
                            </div>
                            <h3 className="font-space text-2xl text-white mb-2">Burn registered on {chain.name}</h3>
                            <p className="text-lunar-400 text-sm mb-6">The portal emitted MissionStarted. This is what the oracle will read.</p>
                            <div className="max-w-md mx-auto text-left bg-space-700/50 rounded-xl p-4 mb-6">
                                <Row label="Mission id">#{result.missionId.toString()}</Row>
                                <Row label="XEN burned">{formatNumber(Number(ethers.formatUnits(result.amount, 18)))}</Row>
                                <Row label="Tier">{P.tiers[result.tier]?.name ?? result.tier}</Row>
                                <Row label="X1 destination"><span className="font-mono text-xs break-all">{result.x1}</span></Row>
                                <Row label="Transaction"><EvmTxLink explorer={chain.explorer} hash={burnHash} /></Row>
                            </div>
                            <p className="text-sm text-lunar-300 mb-6">
                                Next: the burn is scored in the next epoch (built weekly, at least {P.minEpochIntervalDays} days apart). When the public keeper
                                is running it usually submits your claim (runs can be delayed); you can always claim yourself in{' '}
                                <Link to="/missions" className="text-forge-orange hover:underline">Mission Control</Link> within {P.claimWindowDays} days
                                of the epoch. For Orbit / Moon Landing, vesting starts at the claim and vested XNT is withdrawn with "Withdraw vested"
                                (the keeper does not push it).
                            </p>
                            <button onClick={reset} className="btn-outline">Burn more</button>
                        </div>
                    ) : (
                        <>
                            {/* Chain */}
                            <label className="block text-sm text-lunar-400 mb-2">Burn from chain</label>
                            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2 mb-2">
                                {EVM_CHAINS.map((k) => {
                                    const c = CHAINS[k];
                                    const ok = isPortalDeployed(k);
                                    return (
                                        <button
                                            key={k}
                                            onClick={() => setChainKey(k)}
                                            disabled={busy}
                                            title={ok ? c.name : `${c.name}: portal not deployed yet`}
                                            className={`p-2 rounded-xl border-2 transition-all text-center ${chainKey === k ? 'border-forge-orange bg-forge-orange/10' : 'border-white/10 hover:border-white/20'} ${ok ? '' : 'opacity-50'}`}
                                        >
                                            <div className="w-3 h-3 rounded-full mb-1 mx-auto" style={{ backgroundColor: c.color }} />
                                            <div className="text-sm font-medium">{c.shortName}</div>
                                            <div className={`text-[10px] ${ok ? 'text-green-400' : 'text-lunar-500'}`}>{ok ? 'live' : 'not deployed'}</div>
                                        </button>
                                    );
                                })}
                            </div>
                            {!portalReady && (
                                <Notice kind="warn" className="mb-4">
                                    {chain.name}: portal not deployed yet. Burns on this chain are disabled — no transaction can be sent.
                                </Notice>
                            )}
                            {portalReady && wrongNetwork && (
                                <Notice kind="info" className="mb-4">Your EVM wallet is on another network. It will be asked to switch to {chain.name} before approving.</Notice>
                            )}

                            {/* Amount */}
                            <div className="mb-5 mt-4">
                                <label className="block text-sm text-lunar-400 mb-2">XEN amount</label>
                                <div className="relative">
                                    <input
                                        type="text"
                                        inputMode="decimal"
                                        value={amount}
                                        onChange={(e) => setAmount(e.target.value)}
                                        placeholder="Amount of XEN to burn"
                                        className="input-forge pr-20"
                                        disabled={busy}
                                    />
                                    <button
                                        onClick={() => balance !== null && setAmount(ethers.formatUnits(balance, 18))}
                                        disabled={balance === null || busy}
                                        className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-1 bg-forge-orange/20 text-forge-orange text-sm rounded-lg hover:bg-forge-orange/30 disabled:opacity-40"
                                    >
                                        MAX
                                    </button>
                                </div>
                                <div className="flex justify-between mt-1 text-xs text-lunar-400">
                                    <span>Balance on {chain.shortName}: {balance !== null ? formatNumber(Number(ethers.formatUnits(balance, 18))) : '--'} XEN</span>
                                    {amount && amountWei === null && <span className="text-red-400">Invalid amount</span>}
                                    {overBalance && <span className="text-red-400">Above your balance</span>}
                                </div>
                            </div>

                            {/* Tier */}
                            <div className="mb-5">
                                <label className="block text-sm text-lunar-400 mb-2">Mission tier</label>
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                    {P.tiers.map((t) => (
                                        <button
                                            key={t.id}
                                            onClick={() => setTier(t.id)}
                                            disabled={busy}
                                            className={`tier-card text-left !p-4 ${tier === t.id ? 'selected' : ''} ${['tier-launchpad', 'tier-orbit', 'tier-moon'][t.id]}`}
                                        >
                                            <div className="flex items-center gap-2 mb-1">
                                                <span className="text-xl">{t.icon}</span>
                                                <span className="font-space text-white">{t.name}</span>
                                                <span className="ml-auto text-forge-gold font-bold">{t.multiplier}×</span>
                                            </div>
                                            <div className="text-xs text-lunar-400">{t.vestingDays === 0 ? 'Paid instantly at claim' : `Vests over ${t.vestingDays} days from claim`}</div>
                                            <div className={`text-xs ${t.penaltyPct ? 'text-red-400' : 'text-green-400'}`}>
                                                {t.penaltyPct ? `Eject: ${t.penaltyPct}% penalty on the unvested part` : 'No penalty'}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Destination */}
                            <div className="mb-5">
                                <label className="block text-sm text-lunar-400 mb-2">
                                    X1 destination <span className="text-amber-400">(Base58 — receives the XNT)</span>
                                </label>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={dest}
                                        onChange={(e) => { setDestTouched(true); setDest(e.target.value); }}
                                        placeholder="Your X1 wallet address"
                                        className="input-forge font-mono text-sm"
                                        disabled={busy}
                                    />
                                    {!x1Connected && (
                                        <button onClick={connectX1} className="btn-outline !px-3 !py-2 text-sm whitespace-nowrap">Use X1 wallet</button>
                                    )}
                                </div>
                                {destCheck.msg && <p className="mt-1 text-xs text-red-400">{destCheck.msg}</p>}
                                {destCheck.warn && <p className="mt-1 text-xs text-amber-400">{destCheck.warn}</p>}
                            </div>

                            <label className="flex items-start gap-3 mb-5 cursor-pointer text-sm text-lunar-300">
                                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1" disabled={busy} />
                                <span>
                                    I understand the burn is <strong className="text-white">irreversible</strong>, the XNT amount is <strong className="text-white">not fixed and can be small</strong>{' '}
                                    (it is my share of an epoch budget), and the X1 address above is correct.
                                </span>
                            </label>

                            {error && <Notice kind="error" className="mb-4">{error}</Notice>}

                            {(approveHash || burnHash) && (
                                <div className="mb-4 text-xs text-lunar-400 space-y-1">
                                    {approveHash && <div>Approve tx: <EvmTxLink explorer={chain.explorer} hash={approveHash} /></div>}
                                    {burnHash && <div>Burn tx: <EvmTxLink explorer={chain.explorer} hash={burnHash} /></div>}
                                </div>
                            )}

                            {!evmAddress ? (
                                <button onClick={connectEVM} className="w-full btn-forge">Connect EVM wallet (holds your XEN)</button>
                            ) : (
                                <button onClick={handleBurn} disabled={!canBurn} className="w-full btn-forge flex items-center justify-center gap-2">
                                    {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Flame className="w-5 h-5" />}
                                    {step === 'switching' ? `Switching to ${chain.name}…`
                                        : step === 'approve' ? 'Approving exact amount…'
                                            : step === 'burn' ? 'Burning…'
                                                : <>Burn XEN <ArrowRight className="w-5 h-5" /></>}
                                </button>
                            )}
                            <p className="text-xs text-lunar-500 mt-2">The approval is for the exact amount only, never unlimited.</p>
                        </>
                    )}
                </div>

                {/* Side: how the payout works */}
                <div className="space-y-6">
                    <div className="glass-card">
                        <h3 className="font-space text-lg text-forge-gold mb-3">How your payout is computed</h3>
                        <ul className="text-sm text-lunar-300 space-y-2 list-disc list-inside">
                            <li>Value of a burn = XEN amount × burn-hour price of that chain's XEN × L/(L+V), a liquidity discount (L = XEN-side liquidity of that chain's eligible pools, V = total value burned on that chain in the epoch).</li>
                            <li>Score = value × tier multiplier ({tierInfo.multiplier}× for {tierInfo.name}) × your best Artifact boost.</li>
                            <li>Each epoch budget is at most {P.epochBudgetBps / 100}% of the free reward pool, split by score (Forge Drops are part of it).</li>
                            <li>An epoch pays at most {P.tiers.map((t) => `${P.rateCapK * t.multiplier}×`).join(' / ')} the liquidity-adjusted value burned ({P.tiers.map((t) => t.name).join(' / ')}), Forge Drops included, in XNT at the epoch price. Boosts only shift shares between burners of the same epoch, never the total. Whatever is not paid stays in the pool.</li>
                            <li>Launchpad is paid at claim. Orbit and Moon Landing vest linearly from the claim; vested XNT is withdrawn with "Withdraw vested" (anyone can push it; the keeper does not). Claim within {P.claimWindowDays} days of the epoch, or the amount returns to the pool.</li>
                            <li>When the public keeper is running it usually submits your claim (runs can be delayed); its tip ({P.keeperTip} XNT per claim of at least {P.keeperTipMinClaim} XNT) is paid by the pool, never from your amount.</li>
                        </ul>
                    </div>
                    <BurnVsSell chainKey={chainKey} xenAmount={amount} tier={tier} compact />
                </div>
            </div>
            <div className="mt-6"><FairValueEngine /></div>
        </div>
    );
}
