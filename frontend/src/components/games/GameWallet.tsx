/**
 * Game wallet: the PlayerState PDA that holds your game balance and lottery chips.
 * Deposit / withdraw, and an optional session key for bots (house games only, can NEVER withdraw).
 */
import { useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { Wallet, Bot } from 'lucide-react';
import { deposit, ensurePlayer, setSession, withdraw } from '../../lib/protocol';
import { formatNumber, parseXNT, PROJECT_LINKS, shortenAddress } from '../../lib/constants';
import { useTx, useNow } from '../../lib/hooks';
import { Row, TxStatus, Xnt } from '../ui';
import type { GameCtx } from './types';

export default function GameWallet({ ctx }: { ctx: GameCtx }) {
    const { provider, player, refresh } = ctx;
    const tx = useTx();
    const now = useNow(10_000);
    const [dep, setDep] = useState('');
    const [wd, setWd] = useState('');
    const [sessKey, setSessKey] = useState('');
    const [sessHours, setSessHours] = useState('24');
    const [sessMax, setSessMax] = useState('0.1');
    const [showSession, setShowSession] = useState(false);

    const balance = player ? Number(player.balance) : null;
    const sessionActive = player && player.sessionKey && !new PublicKey(player.sessionKey).equals(PublicKey.default) && Number(player.sessionExpires) > now;

    const depVal = Number(dep);
    let wdLamports = 0;
    try { wdLamports = wd ? Number(parseXNT(wd)) : 0; } catch { wdLamports = 0; }
    let sessPk: PublicKey | null = null;
    try { sessPk = sessKey ? new PublicKey(sessKey.trim()) : null; } catch { sessPk = null; }

    return (
        <div className="glass-card">
            <div className="flex items-center gap-2 mb-4">
                <Wallet className="w-5 h-5 text-forge-gold" />
                <h3 className="font-space text-lg">Game wallet</h3>
            </div>
            <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                    <div className="text-xs text-lunar-400">Balance</div>
                    <div className="font-space text-xl text-forge-gold"><Xnt lamports={balance} /></div>
                </div>
                <div>
                    <div className="text-xs text-lunar-400">Lottery chips</div>
                    <div className="font-space text-xl text-white">{player ? formatNumber(Number(player.chips)) : '--'}</div>
                </div>
            </div>
            {!player && provider && <p className="text-xs text-lunar-400 mb-3">No game wallet yet: your first deposit creates it (a small rent deposit, which is not refundable).</p>}

            <div className="grid md:grid-cols-2 gap-3">
                <div className="flex gap-2">
                    <input className="input-forge !py-2" inputMode="decimal" placeholder="Deposit XNT" value={dep} onChange={(e) => setDep(e.target.value)} />
                    <button className="btn-forge !px-4 !py-2 text-sm" disabled={!provider || !(depVal > 0) || !!tx.busy}
                        onClick={() => provider && tx.run(`Depositing ${depVal} XNT`, () => deposit(provider, depVal), () => { setDep(''); refresh(); })}>
                        Deposit
                    </button>
                </div>
                <div className="flex gap-2">
                    <input className="input-forge !py-2" inputMode="decimal" placeholder="Withdraw XNT" value={wd} onChange={(e) => setWd(e.target.value)} />
                    <button className="text-xs text-lunar-400 hover:text-white" disabled={balance === null} onClick={() => balance !== null && setWd((balance / 1e9).toString())}>max</button>
                    <button className="btn-outline !px-4 !py-2 text-sm" disabled={!provider || !player || wdLamports <= 0 || (balance !== null && wdLamports > balance) || !!tx.busy}
                        onClick={() => provider && tx.run('Withdrawing', () => withdraw(provider, wdLamports), () => { setWd(''); refresh(); })}>
                        Withdraw
                    </button>
                </div>
            </div>

            <div className="mt-5 pt-4 border-t border-white/10">
                <button onClick={() => setShowSession(!showSession)} className="flex items-center gap-2 text-sm text-lunar-300 hover:text-white">
                    <Bot className="w-4 h-4" /> Session key (bots) {sessionActive ? <span className="text-green-400">· active</span> : <span className="text-lunar-500">· none</span>}
                </button>
                {showSession && (
                    <div className="mt-3 space-y-3">
                        <p className="text-xs text-lunar-400">
                            A session key (for example a bot's keypair) can place house-game bets (Coin Flip, High-Low, Void Rush) from your game
                            balance, up to a max stake per bet, until it expires. It can <strong className="text-white">never withdraw</strong> (only this
                            wallet can) and it cannot enter the Jackpot, the Burn Lottery or Duels: those accept only the wallet owner. See{' '}
                            <a href={PROJECT_LINKS.botsMd} target="_blank" rel="noopener noreferrer" className="text-forge-orange hover:underline">docs/BOTS.md</a>.
                        </p>
                        {player && (
                            <div className="bg-space-700/40 rounded-lg p-3">
                                <Row label="Current key">{sessionActive ? shortenAddress(new PublicKey(player.sessionKey).toBase58(), 6, 6) : 'none'}</Row>
                                <Row label="Expires">{sessionActive ? new Date(Number(player.sessionExpires) * 1000).toLocaleString() : '--'}</Row>
                                <Row label="Max stake per bet">{sessionActive ? <Xnt lamports={Number(player.sessionMaxStake)} /> : '--'}</Row>
                            </div>
                        )}
                        <input className="input-forge !py-2 font-mono text-sm" placeholder="Session public key (Base58)" value={sessKey} onChange={(e) => setSessKey(e.target.value)} />
                        {sessKey && !sessPk && <p className="text-xs text-red-400">Not a valid Base58 public key</p>}
                        <div className="grid grid-cols-2 gap-2">
                            <label className="text-xs text-lunar-400">Valid for (hours)
                                <input className="input-forge !py-2 mt-1" inputMode="decimal" value={sessHours} onChange={(e) => setSessHours(e.target.value)} />
                            </label>
                            <label className="text-xs text-lunar-400">Max stake per bet (XNT)
                                <input className="input-forge !py-2 mt-1" inputMode="decimal" value={sessMax} onChange={(e) => setSessMax(e.target.value)} />
                            </label>
                        </div>
                        <div className="flex gap-2">
                            <button className="btn-forge !px-4 !py-2 text-sm" disabled={!provider || !sessPk || !(Number(sessHours) > 0) || !(Number(sessMax) >= 0) || !!tx.busy}
                                onClick={() => provider && sessPk && tx.run('Setting session key', async () => {
                                    await ensurePlayer(provider);
                                    return setSession(provider, sessPk!, Number(sessHours), Number(sessMax));
                                }, () => refresh())}>
                                Authorize session
                            </button>
                            {sessionActive && (
                                <button className="btn-outline !px-4 !py-2 text-sm" disabled={!provider || !!tx.busy}
                                    onClick={() => provider && tx.run('Revoking session key', () => setSession(provider, PublicKey.default, 0, 0), () => refresh())}>
                                    Revoke
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>
            <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
        </div>
    );
}
