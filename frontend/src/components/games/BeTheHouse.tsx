/**
 * Be the House — deposit XNT into the game bankroll and own a share of it (its 0.5% edge AND its variance).
 * Withdrawals need a request and a 24 h cooldown and are priced at withdrawal time, so LPs cannot dodge pending bets.
 */
import { useState } from 'react';
import { Landmark } from 'lucide-react';
import { fetchHouseShare, houseDeposit, houseRequestWithdraw, houseShareValue, houseWithdraw, P } from '../../lib/protocol';
import { formatDuration, formatNumber } from '../../lib/constants';
import { useNow, usePoll, useTx } from '../../lib/hooks';
import { Notice, Row, TxStatus, Xnt } from '../ui';
import type { GameCtx } from './types';

export default function BeTheHouse({ ctx }: { ctx: GameCtx }) {
    const { provider, owner, proto, refresh } = ctx;
    const share = usePoll(() => (owner ? fetchHouseShare(owner) : Promise.resolve(null)), [owner?.toBase58()], 30_000);
    const tx = useTx();
    const now = useNow(5000);
    const [dep, setDep] = useState('');
    const [pct, setPct] = useState('100');

    const cfg = proto?.config;
    const totalShares = cfg ? cfg.houseTotalShares.toString() : '0';
    const protocolShares = cfg ? Number(cfg.houseProtocolShares) : 0;
    const s = share.data;
    const myShares = s ? BigInt(s.shares.toString()) : 0n;
    const pending = s ? BigInt(s.pendingShares.toString()) : 0n;
    const unlock = s ? Number(s.unlockTs) : 0;
    const myValue = proto && s ? houseShareValue(myShares, totalShares, proto.bankrollFree) : null;
    const pendingValue = proto && s ? houseShareValue(pending, totalShares, proto.bankrollFree) : null;
    const ownership = proto && s && BigInt(totalShares) > 0n ? Number((myShares * 1_000_000n) / BigInt(totalShares)) / 10_000 : null;

    const depVal = Number(dep);
    const pctVal = Math.min(100, Math.max(0, Number(pct) || 0));
    const reqShares = (myShares * BigInt(Math.round(pctVal * 100))) / 10_000n;

    const reload = () => { share.reload(); refresh(); };

    return (
        <div className="glass-card">
            <div className="flex items-center gap-2 mb-4">
                <Landmark className="w-5 h-5 text-forge-gold" />
                <h3 className="font-space text-lg">Be the House</h3>
            </div>
            <div className="grid md:grid-cols-2 gap-6">
                <div>
                    <Row label="Free bankroll"><Xnt lamports={proto ? proto.bankrollFree : null} /></Row>
                    <Row label="Reserved for open bets"><Xnt lamports={proto ? proto.bankrollReserved : null} /></Row>
                    <Row label="Total shares">{cfg ? formatNumber(Number(totalShares), 0) : '--'}</Row>
                    <Row label="Protocol floor shares (never withdrawable)">{cfg ? formatNumber(protocolShares, 0) : '--'}</Row>
                    <hr className="border-white/10 my-2" />
                    <Row label="Your shares">{s ? formatNumber(Number(myShares), 0) : owner ? '0' : '--'}</Row>
                    <Row label="Your value now">{myValue !== null ? <Xnt lamports={myValue} /> : '--'}</Row>
                    <Row label="Your ownership">{ownership !== null ? `${ownership.toFixed(4)}%` : '--'}</Row>
                    {pending > 0n && (
                        <Row label="Pending withdrawal (value now; priced when you withdraw)">
                            <Xnt lamports={pendingValue} /> · {now >= unlock ? <span className="text-green-400">unlocked</span> : `unlocks in ${formatDuration(unlock - now)}`}
                        </Row>
                    )}
                </div>
                <div className="space-y-3">
                    <div className="flex gap-2">
                        <input className="input-forge !py-2" inputMode="decimal" placeholder="Deposit XNT (min 1)" value={dep} onChange={(e) => setDep(e.target.value)} />
                        <button className="btn-forge !px-4 !py-2 text-sm whitespace-nowrap" disabled={!provider || !(depVal >= 1) || !!tx.busy || !proto?.initialized}
                            onClick={() => provider && tx.run(`Depositing ${depVal} XNT into the bankroll`, () => houseDeposit(provider, depVal), () => { setDep(''); reload(); })}>
                            Deposit
                        </button>
                    </div>
                    <div className="flex gap-2 items-center">
                        <input className="input-forge !py-2" inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value)} />
                        <span className="text-xs text-lunar-400">%</span>
                        <button className="btn-outline !px-4 !py-2 text-sm whitespace-nowrap" disabled={!provider || reqShares <= 0n || !!tx.busy}
                            onClick={() => provider && tx.run('Requesting withdrawal', () => houseRequestWithdraw(provider, reqShares), reload)}>
                            Request withdraw
                        </button>
                    </div>
                    <button className="btn-forge w-full !py-2 text-sm" disabled={!provider || pending <= 0n || now < unlock || !!tx.busy}
                        onClick={() => provider && tx.run('Withdrawing from the bankroll', () => houseWithdraw(provider), reload)}>
                        Withdraw (after cooldown)
                    </button>
                    <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
                </div>
            </div>
            <Notice kind="warn" className="mt-4">
                You take the house side: you earn the {P.edgeToBankrollPct}% of every stake that stays in the bankroll, but you also pay winners.
                You can lose part of your deposit if players win. Deposits are priced as if every pending bet loses (nobody can buy shares cheaply
                while bets are open). Withdrawals need a request and a {P.houseWithdrawHours} h cooldown; the amount is priced when you withdraw (not
                when you request), as if every pending bet wins, so nobody leaves with money owed to winners. A new request replaces the old one and
                restarts the {P.houseWithdrawHours} h timer. The app sets a 1% slippage limit on deposits and withdrawals. All unsettled payouts
                together can never exceed {P.maxTotalExposurePct}% of the bankroll, and a daily circuit breaker refuses new house bets until the next
                UTC day once the bankroll (net of LP deposits and withdrawals) has lost 10% since the start of the UTC day. The first deposit mints
                permanent protocol shares for the value already in the bankroll (bankroll donations made before the first LP included); later
                donations raise the value of every share.
            </Notice>
        </div>
    );
}
