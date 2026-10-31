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
import { CHAINS, EVM_CHAINS, isPortalDeployed, formatNumber, normalizeAmountInput, PROJECT_LINKS } from '../lib/constants';
import { burnXen, errorMessage, fetchMyArtifacts, P, parseMissionStarted, x1ToBytes32, xenBalanceOf } from '../lib/protocol';
import { EvmTxLink, Notice, Row } from './ui';
import BurnVsSell from './BurnVsSell';
import FairValueEngine, { money } from './FairValueEngine';
import { fetchXntUsd } from './BurnVsSell';
import { countedUsd, useChainMarkets, weekCapacity } from '../lib/market';
import { usePoll, useProtocol } from '../lib/hooks';
import { DATED, INTERIM, NEUTRAL } from '../content/interim';
import { LINKS, LINKS_URL } from '../lib/links';
import { deniedDestination, inspectDestination } from '../lib/destination';
import { boundaryHold as boundaryHoldOf, useDetection } from '../v3/detect';
import { BoundaryNotice, HowV3Card, QuotePanel, type V3Gate } from '../v3/ui/QuotePanel';
import { V3_BOUNDARY } from '../v3/facts-v3';
import { KEEPER_TIP_MIN_CLAIM as KEEPER_TIP_MIN_CLAIM_V3 } from '../v3/constants';

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
    const [overAck, setOverAck] = useState(false);
    const markets = useChainMarkets();
    const { data: poolNow } = useProtocol(60_000);
    const [xntUsd, setXntUsd] = useState<number | null>(null);
    useEffect(() => { fetchXntUsd().then(setXntUsd).catch(() => undefined); }, [markets.updatedAt]);

    const [balance, setBalance] = useState<bigint | null>(null);
    const [step, setStep] = useState<Step>('idle');
    const [approveHash, setApproveHash] = useState<string | null>(null);
    const [burnHash, setBurnHash] = useState<string | null>(null);
    const [result, setResult] = useState<ReturnType<typeof parseMissionStarted>>(null);
    const [error, setError] = useState<string | null>(null);
    // Rewards v3 (src/v3/detect.ts: the newest epoch file is version 3, or the announced boundary transaction is the newest
    // publication): the binding quote replaces the v2 estimate. False on the live oracle, which keeps this page exactly as it is.
    const det = useDetection();
    const v3 = det.rewards === 3;
    // The live (v2) estimate and the burn on v2 checks: always while no boundary is announced (today); once it is, only
    // while detection positively reads rewards 2 before the planned date and before the boundary transaction exists.
    // Otherwise the burn is held (fail-closed: a failed read after the announcement never falls back to the v2 estimate).
    // The clock is read at render; the 60 s pool polls below re-render the page.
    const hold = v3 ? null : boundaryHoldOf(det.rewards, V3_BOUNDARY, Date.now());
    const v2Path = !v3 && hold === null;
    const boundaryHold = !v3 && !v2Path;
    // Rules 3 (the upgraded program writes no drop reserve for a new epoch; Artifacts give no boost, chips or ticket):
    // the drop and boost texts below describe only the program before the upgrade. False on the live program.
    const rules3 = det.rules === 3;
    const [v3Gate, setV3Gate] = useState<V3Gate>({ ok: false, requote: async () => false });

    // Prefill the destination once from the connected X1 wallet (never overwrite what the user typed).
    useEffect(() => {
        if (x1Address && !destTouched) setDest(x1Address);
    }, [x1Address, destTouched]);

    // XEN balance on the SELECTED chain (read-only RPC, independent of MetaMask's current network).
    useEffect(() => {
        let alive = true;
        setBalance(null);
        // R10: no read on a chain without a portal (its RPC would see the visitor for no function).
        if (!evmAddress || !isPortalDeployed(chainKey)) return;
        const rpc = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
        xenBalanceOf(rpc, chain.xenToken, evmAddress)
            .then((b) => { if (alive) setBalance(b); })
            .catch(() => { if (alive) setBalance(null); });
        return () => { alive = false; };
    }, [evmAddress, chainKey, step === 'done']); // eslint-disable-line react-hooks/exhaustive-deps

    const amountWei = useMemo(() => {
        try {
            const s = normalizeAmountInput(amount);
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
            if (pk.equals(PublicKey.default)) return { ok: false, msg: 'This is the all-zero address: nobody can ever use XNT sent to it.', warn: null };
            // R5: programs, sysvars and protocol accounts can never be credited or sign: XNT sent there is lost for good.
            const denied = deniedDestination(pk);
            if (denied) return { ok: false, msg: `This is ${denied}, not a wallet: XNT sent there can never be received or used. Paste your own X1 wallet address.`, warn: null };
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

    // Destination holds the Artifact? (X-157) Under the current rules the boost follows the burn's X1 destination, not the person.
    // Read once per valid destination (no interval); null while unknown, so no warning is ever shown on a failed read.
    const destKey = destCheck.ok ? dest.trim() : null;
    const destArtifacts = usePoll(() => (destKey ? fetchMyArtifacts(new PublicKey(destKey)).then((a) => a.length) : Promise.resolve(null)), [destKey], 0);
    const walletArtifacts = usePoll(
        () => (x1Address && x1Address !== destKey ? fetchMyArtifacts(new PublicKey(x1Address)).then((a) => a.length) : Promise.resolve(null)),
        [x1Address, destKey], 0,
    );
    const artifactElsewhere = !!destKey && !!x1Address && x1Address !== destKey && (walletArtifacts.data ?? 0) > 0 && destArtifacts.data === 0;
    // R5: one read-only look-up of the destination account. A program (executable) is blocked; an account owned by
    // another program needs a second, explicit confirmation; a missing account is a fresh wallet (normal).
    const destAcct = usePoll(() => (destKey ? inspectDestination(new PublicKey(destKey)) : Promise.resolve(null)), [destKey], 0);
    const destKind = destKey ? destAcct.data : null;
    const destBlocked = destKind?.kind === 'executable';
    const destUnusual = destKind?.kind === 'owned';
    const [destRiskAck, setDestRiskAck] = useState(false);
    useEffect(() => setDestRiskAck(false), [destKey]);

    // Fair capacity: does this burn fit what this week's budget can pay at least at the value of a sale?
    const fair = useMemo(() => {
        const cap = weekCapacity(markets.rows, poolNow ? Number(poolNow.nextEpochBudget) / 1e9 : null, xntUsd, P.rateCapK);
        const r = markets.rows[chainKey];
        // this chain's own market and its own burns this week must be known (another chain's failure only adds a caveat)
        if (!cap || !amountWei || typeof r !== 'object' || !r.market || r.burnedWeek === null) return null;
        const xen = Number(ethers.formatUnits(amountWei, 18));
        const counted = countedUsd(r.market, r.burnedWeek ?? 0, xen);
        const score = counted * P.tiers[tier].multiplier;
        const total = cap.countedWeekUsd + score;
        const rate = total > 0 ? Math.min(P.rateCapK, cap.budgetUsd / total) : P.rateCapK;
        return { ...cap, counted, score, fits: score <= cap.remainingUsd, estimateUsd: rate * score * cap.cashFraction };
    }, [markets.rows, chainKey, amountWei, poolNow, xntUsd, tier]);
    useEffect(() => setOverAck(false), [amount, chainKey, tier]);
    // Any edit invalidates the "irreversible, address is correct" confirmation.
    useEffect(() => setAck(false), [amount, dest, chainKey, tier]);
    const overBalance = balance !== null && amountWei !== null && amountWei > balance;
    const wrongNetwork = !!evmAddress && evmChainId !== chain.chainId;
    const busy = step === 'switching' || step === 'approve' || step === 'burn';
    // Fail closed: without this chain's market and the week's capacity there is no quote to check the burn against.
    const quoteMissing = amountWei !== null && !fair;
    const destSafe = destCheck.ok && destAcct.data !== null && !destAcct.loading && !destBlocked && (!destUnusual || destRiskAck);
    const quoteOk = v3 ? v3Gate.ok : v2Path ? !!fair && (fair.fits || overAck) : false;
    const canBurn = !!evmAddress && portalReady && amountWei !== null && !overBalance && destSafe && ack && quoteOk && !busy;

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

            // rewards v3: re-quote from fresh data right before signing; refuse if the quote got worse than what was shown
            if (v3 && !(await v3Gate.requote())) throw new Error('The quote changed since it was shown (or could not be recomputed). Review the new numbers and confirm again.');

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

            {V3_BOUNDARY && <BoundaryNotice boundary={V3_BOUNDARY} className="mb-6" />}

            {pool && v2Path && !rules3 && (
                <Notice kind="info" className="mb-6">
                    <strong>Forge Drops:</strong> up to {P.dropBudgetPct}% of each epoch budget (max {P.maxDropsPerEpoch * P.dropBackingXnt} XNT) is drawn
                    among that epoch's burners as Lunar Dust Artifacts whose floor is the drop value (at least {P.dropBackingXnt} XNT). Drops are part of
                    the budget, not extra, and are paid in XNT if Lunar Dust is sold out (next epoch: up to ≈ {formatNumber(pool.nextDropReserve / 1e9)} XNT
                    of drops). Your chance grows linearly with what you burn; a winner can recycle the Artifact for its floor at once or keep it for a
                    +5% share boost (it counts once held at two consecutive epoch snapshots), weekly lottery chips and entry to Artifact Duel and Moon Wars.
                    <div className="mt-2 text-xs text-lunar-300">
                        {DATED}: {NEUTRAL.oracleRules} A drop already won stays claimable for its {P.claimWindowDays}-day window; an unused reserve
                        returns to the pool.
                    </div>
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
                                is running it may submit your claim for you (its runs are irregular and can be hours or days late); you can always claim yourself in{' '}
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
                                            title={ok ? c.name : `${c.name}: no portal (not supported)`}
                                            className={`p-2 rounded-xl border-2 transition-all text-center ${chainKey === k ? 'border-forge-orange bg-forge-orange/10' : 'border-white/10 hover:border-white/20'} ${ok ? '' : 'opacity-50'}`}
                                        >
                                            <div className="w-3 h-3 rounded-full mb-1 mx-auto" style={{ backgroundColor: c.color }} />
                                            <div className="text-sm font-medium">{c.shortName}</div>
                                            <div className={`text-[10px] ${ok ? 'text-green-400' : 'text-lunar-500'}`}>{ok ? 'live' : 'not supported'}</div>
                                        </button>
                                    );
                                })}
                            </div>
                            {!portalReady && (
                                <Notice kind="warn" className="mb-4">
                                    {chain.name}: no portal (not supported; none is planned by this project). Burns on this chain are disabled and no transaction can be sent.
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
                                    {amount && amountWei === null && <span className="text-red-400">Invalid amount: digits only, one "." or "," for decimals, no thousands separators</span>}
                                    {amountWei !== null && !overBalance && <span className="text-lunar-300">= {formatNumber(Number(ethers.formatUnits(amountWei, 18)))} XEN</span>}
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
                                {destKey && destAcct.loading && <p className="mt-1 text-xs text-lunar-400">Checking this address on X1…</p>}
                                {destBlocked && (
                                    <p className="mt-1 text-xs text-red-400">
                                        This address is a program on X1, not a wallet: it can never receive XNT or sign. Burning is disabled for this destination.
                                    </p>
                                )}
                                {destUnusual && destKind?.kind === 'owned' && (
                                    <div className="mt-2 p-2 rounded-lg border border-red-500/50 bg-red-500/5 text-xs text-red-300">
                                        This address already exists on X1 and is owned by {destKind.ownerName ?? <span className="font-mono break-all">{destKind.owner}</span>}, not by
                                        the System program: it is not a regular wallet (for example a token account or a program's data account). XNT credited there may be
                                        impossible to use, and claims, ejects and games need a wallet key.
                                        <label className="flex items-start gap-2 mt-2 cursor-pointer">
                                            <input type="checkbox" className="mt-0.5" checked={destRiskAck} onChange={(e) => setDestRiskAck(e.target.checked)} disabled={busy} />
                                            <span>I checked this address: it is mine and I know how to use XNT sent to it.</span>
                                        </label>
                                    </div>
                                )}
                                {destKind?.kind === 'unknown' && (
                                    <p className="mt-1 text-xs text-amber-400">This address could not be checked on X1 right now (RPC unavailable). Make sure it is your own X1 wallet.</p>
                                )}
                                {artifactElsewhere && v2Path && !rules3 && (
                                    <p className="mt-1 text-xs text-amber-400">
                                        Your connected X1 wallet holds {walletArtifacts.data} Artifact{walletArtifacts.data === 1 ? '' : 's'} and this destination holds none.
                                        Under the current rules the Artifact boost counts only for burns whose destination is the wallet holding the Artifact at two
                                        consecutive epoch snapshots: a burn sent here gets no boost.
                                    </p>
                                )}
                                {destKey && destArtifacts.data !== null && destArtifacts.data > 0 && (
                                    <p className="mt-1 text-xs text-lunar-400">This destination holds {destArtifacts.data} Artifact{destArtifacts.data === 1 ? '' : 's'}.</p>
                                )}
                                <ul className="mt-2 text-xs text-lunar-500 list-disc list-inside space-y-0.5">
                                    <li>
                                        Use an X1 wallet whose private key you hold. Never an exchange deposit address, a contract or a program address: XNT lands
                                        there, but claims, "Withdraw vested", ejects and games need this key's signature.
                                    </li>
                                    <li>
                                        The same keypair works on X1 and Solana, but X1 is its own network: a Solana wallet app must be pointed at the X1 RPC to see
                                        the XNT, and a Solana exchange address is not yours on X1.
                                    </li>
                                    <li>
                                        Your EVM address and this X1 address are linked publicly and permanently: the portal event (MissionStarted) and the epoch
                                        file record both. Use a fresh X1 address if you do not want that link.
                                    </li>
                                </ul>
                            </div>

                            {v3 && portalReady && (
                                <QuotePanel chainKey={chainKey} chainId={chain.chainId} amountWei={amountWei} tier={tier} busy={busy} onGate={setV3Gate} x1={destKey} />
                            )}

                            {boundaryHold && portalReady && (
                                <Notice kind="warn" className="mb-4">
                                    <div className="font-bold text-white">Burning from this page is paused right now</div>
                                    <div>
                                        {hold === 'tx-known'
                                            ? 'Burns sent now are paid under the v3 rules, and this page could not yet confirm the boundary in the published epoch files, so it has no quote to show.'
                                            : hold === 'date-reached'
                                                ? `The last epoch under the current reward rules is planned for publication on ${V3_BOUNDARY?.date ?? 'the announced date'} (UTC), and a burn made after its publish transaction is paid under the v3 rules. From that date this page holds the burn until an update of this site names that transaction${V3_BOUNDARY?.releaseUtc ? ` (planned for ${V3_BOUNDARY.releaseUtc} UTC)` : ''}. A burn made after that transaction is never paid under the current rules: if the final upgrade comes later, it waits for the first epoch built under the v3 rules, with its own time.`
                                                : det.pending
                                                    ? 'This page is still reading the published epoch files to tell which reward rules a burn sent now falls under.'
                                                    : 'This page could not read the published epoch files, so it cannot tell which reward rules a burn sent now falls under.'}
                                        {hold === 'date-reached' ? '' : ' It checks again every few minutes; reload the page to retry now.'}
                                        {' '}Nothing here stops a burn you send from another client, and such a burn is scored under the published rules.
                                    </div>
                                </Notice>
                            )}

                            {v2Path && quoteMissing && portalReady && (
                                <Notice kind="warn" className="mb-4">
                                    <div>
                                        {(() => {
                                            // E2E-site-chains: say which source is missing; a busy or rate-limited source is not "no market"
                                            const row = markets.rows[chainKey];
                                            if (row === 'loading') return `Loading the XEN market of ${chain.name} and this week's burns there. Burning stays disabled until they load.`;
                                            if (typeof row === 'object' && !row.market && row.marketError) return `No quote yet: the XEN price source did not answer for ${chain.name} (busy or rate-limited; this does not mean it has no market). Burning on ${chain.name} stays disabled until it loads; other chains are not affected.`;
                                            if (typeof row === 'object' && !row.market) return `${chain.name} has no eligible XEN market right now, so a burn there would be valued at $0. Burning on ${chain.name} stays disabled until it has one.`;
                                            if (typeof row === 'object' && row.burnedWeek === null) return `No quote yet: the portal on ${chain.name} could not be read (its RPC did not answer), so this week's burns there are unknown. Burning on ${chain.name} stays disabled until it loads; other chains are not affected.`;
                                            return 'No quote yet: this week\'s capacity has not loaded (the reward pool, the XNT price or another chain is still being read). Burning stays disabled until it loads, because without it a burn cannot be checked against the capacity.';
                                        })()}
                                    </div>
                                    <button onClick={markets.refresh} className="btn-outline !px-3 !py-1 text-sm mt-2" disabled={busy}>Retry</button>
                                </Notice>
                            )}

                            {v2Path && fair && fair.unread.length > 0 && (
                                <p className="text-xs text-amber-400 mb-2">
                                    Not counted right now: this week's burns on {fair.unread.join(', ')} (the data could not be read), so the capacity left may be lower than shown below.
                                </p>
                            )}
                            {v2Path && fair && (fair.fits ? (
                                <Notice kind="success" className="mb-4">
                                    Fits this week's fair capacity ({money(fair.remainingUsd)} left). This burn counts for about {money(fair.counted)}{tierInfo.multiplier > 1 ? ` (×${tierInfo.multiplier} for ${tierInfo.name})` : ''};
                                    at today's numbers the epoch should pay about {money(fair.estimateUsd)} in XNT, at least what selling it would return{rules3 ? '. ' : ', plus (under the current rules) a chance at a Forge Drop. '}
                                    It can still drop if others burn before Sunday, and other people's Orbit / Moon Landing burns weigh 2× / 3×.
                                    {' '}Gas is paid separately (two transactions: approve, then burn) and your wallet shows it before you sign: if it is more than {money(fair.estimateUsd)}, this burn costs more than it pays.
                                </Notice>
                            ) : (
                                <Notice kind="warn" className="mb-4">
                                    <div>
                                        Above this week's fair capacity: the reward pool can pay at least the value of a sale for only {money(fair.remainingUsd)} more of counted value this week,
                                        and this burn counts for about {money(fair.score)}. At today's numbers the epoch would pay about {money(fair.estimateUsd)} in XNT for it, likely less than selling.
                                        Burn less, wait for the pool to grow, or confirm below.
                                    </div>
                                    <label className="flex items-start gap-2 mt-2 cursor-pointer">
                                        <input type="checkbox" checked={overAck} onChange={(e) => setOverAck(e.target.checked)} className="mt-1" disabled={busy} />
                                        <span>I understand this burn is above the fair capacity and will probably pay less than selling, and I still want to burn.</span>
                                    </label>
                                </Notice>
                            ))}

                            <p className="text-xs text-lunar-500 mb-3">
                                Privacy: {LINKS.privacy.sentence} The services that see your IP address are listed in{' '}
                                <a className="text-forge-orange hover:underline" href={LINKS_URL} target="_blank" rel="noopener noreferrer">links.json</a>.
                            </p>

                            <label className="flex items-start gap-3 mb-5 cursor-pointer text-sm text-lunar-300">
                                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1" disabled={busy} />
                                <span>
                                    I understand the burn is <strong className="text-white">irreversible</strong> (it cannot be used in XEN Prime or any other program and will not count in any
                                    future snapshot), the XNT amount is <strong className="text-white">not fixed and can be small</strong> (it is my share of an epoch budget, paid only if the
                                    oracle publishes the epoch), and the X1 address above is correct and its key is mine.
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
                    {v3 ? <HowV3Card /> : v2Path ? <div className="glass-card">
                        <h3 className="font-space text-lg text-forge-gold mb-3">How your payout is computed</h3>
                        <ul className="text-sm text-lunar-300 space-y-2 list-disc list-inside">
                            <li>Value of a burn = XEN amount × burn-hour price of that chain's XEN × L/(L+V), a liquidity discount (L = XEN-side liquidity of that chain's eligible pools, V = total value burned on that chain in the epoch).</li>
                            <li>Score = value × tier multiplier ({tierInfo.multiplier}× for {tierInfo.name}){rules3 ? '.' : ' × your best Artifact boost.'}</li>
                            <li>Each epoch budget is at most {P.epochBudgetBps / 100}% of the free reward pool, split by score{rules3 ? '.' : ' (Forge Drops are part of it).'}</li>
                            <li>An epoch pays at most {P.tiers.map((t) => `${P.rateCapK * t.multiplier}×`).join(' / ')} the liquidity-adjusted value burned ({P.tiers.map((t) => t.name).join(' / ')}){rules3 ? '' : ', Forge Drops included,'} in XNT at the epoch price.{rules3 ? '' : ' Boosts only shift shares between burners of the same epoch, never the total.'} Whatever is not paid stays in the pool.</li>
                            <li>Launchpad is paid at claim. Orbit and Moon Landing vest linearly from the claim; vested XNT is withdrawn with "Withdraw vested" (anyone can push it; the keeper does not). Claim within {P.claimWindowDays} days of the epoch, or the amount returns to the pool.</li>
                            <li>When the public keeper is running it may submit your claim for you (its runs are irregular and can be hours or days late); its tip ({P.keeperTip} XNT per claim of at least {rules3 ? Number(KEEPER_TIP_MIN_CLAIM_V3) / 1e9 : P.keeperTipMinClaim} XNT) is paid by the pool, never from your amount.</li>
                            <li className="text-lunar-500">
                                {DATED}: these are the current oracle rules. They are scheduled to be replaced ({INTERIM.rulesChangeWhen}); every burn made before that
                                date is scored under the rules of the epoch it falls in. What replaces them is published with the announcement, not before.
                            </li>
                        </ul>
                    </div> : null}
                    {v2Path && <BurnVsSell chainKey={chainKey} xenAmount={amount} tier={tier} compact />}
                    <div className="glass-card text-sm text-lunar-300">
                        <div className="text-white font-medium mb-1">Once your XNT arrives</div>
                        It is an ordinary X1 balance in your wallet: keep it, move it, or use it anywhere on X1. Nothing here needs you to do anything else with it.
                        <div className="mt-2 flex flex-wrap gap-3"><Link className="text-forge-orange hover:underline" to="/missions">Mission Control</Link><Link className="text-forge-orange hover:underline" to="/start">How it all fits</Link></div>
                    </div>
                </div>
            </div>
            {v2Path && <div className="mt-6"><FairValueEngine compact /></div>}
        </div>
    );
}
