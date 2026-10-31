/**
 * Mission Control, rules 3: the wallet's extra-pot leaves (forged Artifacts' rebate). A leaf is claimable only when the
 * published file's root equals the root on X1 and its proof walks to it in this browser (src/v3/extra.ts); "could not
 * load" is never shown as "nothing to claim".
 */
import { PublicKey } from '@solana/web3.js';
import { Gem } from 'lucide-react';
import { usePoll, useTx } from '../../lib/hooks';
import { readConnection } from '../../lib/protocol';
import { formatDuration } from '../../lib/constants';
import { Notice, TxStatus, Xnt } from '../../components/ui';
import { readRules } from '../detect';
import { fetchMyExtraLeaves } from '../extra';
import { claimExtraV3 } from '../actions';
import { artifactRulesS7 } from '../facts-s7';
import type { WalletLike } from '../program';

export default function ExtraClaims({ owner, readOnly, provider, now }: { owner: string; readOnly: boolean; provider: WalletLike | null; now: number }) {
    const data = usePoll(async () => {
        const r = await readRules(readConnection);
        if (r.rules !== 3 || !r.extraState) return { leaves: [], errors: [], last: 0 };
        const last = Number(r.extraState.lastEpoch);
        const res = last > 0 ? await fetchMyExtraLeaves(readConnection, new PublicKey(owner), last) : { leaves: [], errors: [] };
        return { ...res, last };
    }, [owner], 120_000);
    const tx = useTx();
    const leaves = data.data?.leaves ?? [];
    return (
        <section className="glass-card">
            <div className="flex items-center gap-2 mb-2">
                <Gem className="w-5 h-5 text-forge-gold" />
                <h2 className="font-space text-xl">Extra pot (Artifact rebate)</h2>
            </div>
            <p className="text-xs text-lunar-500 mb-3">{artifactRulesS7.extraPot}</p>
            <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
            {data.error && <Notice kind="error">Could not load the extra epochs: {data.error}</Notice>}
            {(data.data?.errors ?? []).map((e) => <Notice key={e} kind="warn" className="mt-2">Could not load {e}</Notice>)}
            {data.loading && !data.data && <p className="text-sm text-lunar-400">Reading the extra epochs…</p>}
            {data.data && data.data.last === 0 && <p className="text-sm text-lunar-400">No extra epoch has been published yet.</p>}
            {data.data && data.data.last > 0 && leaves.length === 0 && (data.data.errors.length === 0) && (
                <p className="text-sm text-lunar-400">This wallet has no leaf in the last extra epochs (up to #{data.data.last}).</p>
            )}
            {leaves.length > 0 && (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead><tr className="text-left text-lunar-400 border-b border-white/10"><th className="py-2 pr-3">Extra epoch</th><th className="py-2 pr-3">Amount</th><th className="py-2 pr-3">Checked</th><th className="py-2">Status</th></tr></thead>
                        <tbody>
                            {leaves.map((l) => (
                                <tr key={`${l.epoch}-${l.index}`} className="border-b border-white/5">
                                    <td className="py-2 pr-3">#{l.epoch}</td>
                                    <td className="py-2 pr-3"><Xnt lamports={Number(l.amount)} /></td>
                                    <td className="py-2 pr-3 text-xs">{l.verified ? <span className="text-green-400">proof = root on X1</span> : <span className="text-amber-400">not verified</span>}</td>
                                    <td className="py-2 text-xs">
                                        {l.status === 'claimable' && !readOnly && provider ? (
                                            <button className="btn-forge !px-3 !py-1 text-xs" disabled={!!tx.busy}
                                                onClick={() => tx.run(`Claiming extra epoch ${l.epoch}`, () => claimExtraV3(provider, l), data.reload)}>Claim</button>
                                        ) : l.status === 'on-hold' && l.opensAt ? `opens in ${formatDuration(l.opensAt - now)}` : l.detail}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
