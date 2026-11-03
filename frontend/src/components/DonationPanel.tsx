/**
 * Donations — the program's `donate(target, amount)` moves 100% of the amount into the chosen vault.
 *   0 = reward pool (burners) · 1 = game bankroll · 2 = Burn Lottery prize vault (live program only)
 * Live balances are read from chain (balance − rent − reserved).
 * Rules 3 (src/v3/detect.ts): the upgraded program refuses donations to the Burn Lottery vault (no instruction pays it out
 * after the last legacy round), so that target is not offered; false on the live program, which keeps all three.
 */

import { useEffect, useState } from 'react';
import { Heart } from 'lucide-react';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '../context/WalletContext';
import { useProtocol, useTx } from '../lib/hooks';
import { donate, donateWxnt, fetchWxnt, PDA } from '../lib/protocol';
import { PROJECT_LINKS } from '../lib/constants';
import { AddrLink, Notice, TxStatus, X1Gate, Xnt } from './ui';
import { useRules3 } from '../v3/detect';

/** Rules 3: the reward pool text under the upgraded program (each base epoch spends at most 10% of the free pool). */
const REWARD_POOL_V3 = 'Funds the weekly epochs that pay burners: each base epoch can spend at most 10% of the free pool, a bound the program enforces; what an epoch does not pay stays in the pool.';

const TARGETS = [
    { id: 0 as const, name: 'Reward pool', who: 'Burners', desc: 'Funds future epochs. Each epoch budget is at most 10% of the free pool (less when the epoch rate cap — 1.25× the liquidity-adjusted value burned, by tier — is lower).', vault: () => PDA.rewardVault() },
    { id: 1 as const, name: 'Game bankroll', who: 'House games', desc: 'Backs Coin Flip / High-Low / Void Rush payouts. A bigger bankroll allows bigger bets (max net win per bet = 0.25% of the free bankroll). Before the first LP deposit, donations here become permanent protocol shares; afterwards they raise the value of every share.', vault: () => PDA.bankrollVault() },
    { id: 2 as const, name: 'Burn Lottery', who: '7-day rounds', desc: 'Prize vault. Each round the winner takes 50% of it and the rest stays in the vault; if a draw expires unsettled, that 50% goes to the reward pool instead.', vault: () => PDA.drawVault() },
];

export default function DonationPanel() {
    const { x1Provider } = useWallet();
    const proto = useProtocol(20_000);
    const tx = useTx();
    const [target, setTarget] = useState<0 | 1 | 2>(0);
    const [amount, setAmount] = useState('');
    const rules3 = useRules3();
    const targets = rules3 ? TARGETS.filter((t) => t.id !== 2).map((t) => (t.id === 0 ? { ...t, desc: REWARD_POOL_V3 } : t)) : TARGETS;
    // a target the upgraded program refuses is never sent
    useEffect(() => { if (rules3 && target === 2) setTarget(0); }, [rules3, target]);
    const chosen = targets.find((t) => t.id === target) ?? targets[0];

    const [wxnt, setWxnt] = useState<number | null>(null);
    useEffect(() => {
        if (!x1Provider) { setWxnt(null); return; }
        fetchWxnt(new PublicKey(x1Provider.publicKey.toString())).then((r) => setWxnt(r.total)).catch(() => setWxnt(null));
    }, [x1Provider, tx.lastTx]);

    const value = Number(amount);
    const valid = isFinite(value) && value > 0;
    const d = proto.data;
    const balances = [d?.rewardFree, d?.bankrollFree, d?.drawVault];
    const donated = d?.config ? [d.config.stats.donatedReward, d.config.stats.donatedBankroll, d.config.stats.donatedDraw].map((x: any) => Number(x.toString())) : [null, null, null];

    return (
        <div className="space-y-6">
            <div className={`grid grid-cols-1 ${rules3 ? 'md:grid-cols-2' : 'md:grid-cols-3'} gap-4`}>
                {targets.map((t) => (
                    <button
                        key={t.id}
                        onClick={() => setTarget(t.id)}
                        className={`glass-card text-left !p-4 ${target === t.id ? 'border-forge-orange shadow-lg shadow-forge-orange/20' : ''}`}
                    >
                        <div className="text-xs text-lunar-400 uppercase tracking-wider">{t.who}</div>
                        <div className="font-space text-lg text-white mb-1">{t.name}</div>
                        <div className="font-space text-xl text-forge-gold"><Xnt lamports={balances[t.id] ?? null} digits={2} /></div>
                        <div className="text-xs text-lunar-500 mt-1">Donated so far: <Xnt lamports={donated[t.id]} digits={2} /></div>
                        <div className="text-xs text-lunar-400 mt-2">{t.desc}</div>
                        <div className="text-xs mt-2">Vault: <AddrLink address={t.vault()} /></div>
                    </button>
                ))}
            </div>

            {proto.error && <Notice kind="warn">Live balances unavailable: {proto.error}</Notice>}
            {d && !d.initialized && <Notice kind="warn">The program config is not initialized on X1 yet; donations will fail until it is.</Notice>}

            <X1Gate why="Connect your X1 wallet to donate XNT.">
                <div className="glass-card">
                    <div className="flex items-center gap-2 mb-4">
                        <Heart className="w-5 h-5 text-forge-orange" />
                        <h3 className="font-space text-lg">Donate to the {chosen.name}</h3>
                    </div>
                    <div className="flex gap-2 mb-3">
                        <input
                            className="input-forge"
                            inputMode="decimal"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            placeholder="Amount in XNT"
                        />
                        <button
                            className="btn-forge whitespace-nowrap"
                            disabled={!valid || !!tx.busy || !x1Provider || (rules3 && target === 2)}
                            onClick={() => x1Provider && tx.run(`Donating ${value} XNT`, () => donate(x1Provider, chosen.id, value), () => { setAmount(''); proto.reload(); })}
                        >
                            Donate
                        </button>
                    </div>
                    {wxnt !== null && wxnt > 0 && (
                        <div className="flex items-center justify-between gap-2 mb-3 text-sm bg-space-800/50 rounded-lg p-3">
                            <span className="text-lunar-300">You hold <Xnt lamports={wxnt} digits={4} /> as WXNT (wrapped XNT).</span>
                            <button
                                className="btn-outline whitespace-nowrap !py-1"
                                disabled={!!tx.busy || !x1Provider}
                                onClick={() => x1Provider && tx.run('Unwrapping and donating all WXNT', () => donateWxnt(x1Provider, chosen.id), () => proto.reload())}
                            >
                                Donate all WXNT
                            </button>
                        </div>
                    )}
                    <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
                    <p className="text-xs text-lunar-500 mt-3">
                        100% of the amount is transferred to the vault by the program (see <code>donate</code> in
                        {' '}<a href={`${PROJECT_LINKS.github}/blob/main/programs/moon-forge/src/instructions/forge.rs`} target="_blank" rel="noopener noreferrer" className="text-forge-orange hover:underline">forge.rs</a>).
                        {rules3 ? <>
                            Nobody can withdraw a donation: reward-pool XNT only leaves through epoch claims and keeper tips; bankroll XNT only through
                            game payouts and house-LP withdrawals. The Burn Lottery takes no donations since the final upgrade. Whether the program can
                            still be upgraded is shown on the Transparency page.
                        </> : <>
                        Nobody can withdraw a donation: reward-pool XNT only leaves through epoch claims, Forge Drops and keeper tips; bankroll XNT
                        only through game payouts and house-LP withdrawals; lottery XNT only to round winners (or to the reward pool when a draw
                        expires). Note: the program is still upgradeable during the test period (see Transparency).
                        </>}
                    </p>
                </div>
            </X1Gate>
        </div>
    );
}
