/**
 * Verify-this-leaf (shown from the switch epoch on, rewards = 3): recomputes each of the wallet's base leaves in the
 * browser and walks its proof to the root of the published file and to the root stored on X1 (lib/verify-leaf.ts).
 */
import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { fetchEpochAccounts, fetchEpochFile, type MyLeaf } from '../../lib/protocol';
import { leafOfFile, verifyBaseLeaf, type LeafCheck } from '../../lib/verify-leaf';
import { hex } from '../layout';
import { Notice } from '../../components/ui';
import { githubDependence } from '../facts-v3';

interface Row { key: string; epoch: number; tier: number; file: LeafCheck | null; chainRoot: string | null; error?: string }

export default function VerifyLeafPanel({ owner, leaves }: { owner: string; leaves: MyLeaf[] | null }) {
    const [rows, setRows] = useState<Row[] | null>(null);
    const [busy, setBusy] = useState(false);
    const run = async () => {
        if (!leaves) return;
        setBusy(true);
        const out: Row[] = [];
        for (const l of leaves) {
            const key = `${l.epoch}-${l.tier}`;
            try {
                const f = await fetchEpochFile(l.epoch);
                const leaf = leafOfFile(f, owner, l.tier);
                const [ep] = await fetchEpochAccounts([l.epoch]);
                const chainRoot = ep ? hex(Uint8Array.from(ep.root)) : null;
                out.push({ key, epoch: l.epoch, tier: l.tier, chainRoot, file: leaf ? verifyBaseLeaf({ epoch: l.epoch, player: owner, tier: l.tier, score: leaf.score, proof: leaf.proof, root: f.root }) : null });
            } catch (e: any) {
                out.push({ key, epoch: l.epoch, tier: l.tier, file: null, chainRoot: null, error: String(e?.message ?? e).slice(0, 160) });
            }
        }
        setRows(out);
        setBusy(false);
    };
    return (
        <section className="glass-card">
            <div className="flex items-center gap-2 mb-2">
                <ShieldCheck className="w-5 h-5 text-forge-gold" />
                <h2 className="font-space text-xl">Verify my leaves</h2>
            </div>
            <p className="text-xs text-lunar-400 mb-3">
                Recomputes each leaf (keccak of the epoch, your address, the tier and the amount) and walks its proof to the root, here in your browser; the result
                must equal both the published file’s root and the root the program stored on X1. {githubDependence}
            </p>
            <button className="btn-outline !px-3 !py-1 text-sm" disabled={busy || !leaves || leaves.length === 0} onClick={run}>{busy ? 'Checking…' : 'Verify'}</button>
            {rows && (
                <ul className="mt-3 space-y-1 text-xs">
                    {rows.map((r) => {
                        const ok = !!r.file?.ok && r.chainRoot === r.file?.computedRoot;
                        return (
                            <li key={r.key} className={ok ? 'text-green-400' : 'text-red-300'}>
                                Epoch {r.epoch}, tier {r.tier}: {r.error ? `could not check (${r.error})` : !r.file ? 'no leaf for this wallet in the file' : ok ? `verified, root ${r.file.computedRoot.slice(0, 8)}…${r.file.computedRoot.slice(-4)}` : `MISMATCH: computed ${r.file.computedRoot.slice(0, 12)}…, file ${r.file.expectedRoot.slice(0, 12)}…, X1 ${r.chainRoot ? r.chainRoot.slice(0, 12) + '…' : 'not found'}`}
                            </li>
                        );
                    })}
                </ul>
            )}
            {rows && rows.some((r) => !r.error && !(r.file?.ok && r.chainRoot === r.file?.computedRoot)) && (
                <Notice kind="error" className="mt-2">A leaf did not verify. Do not rely on this page’s numbers for it; report it through the official channels listed on the Start page.</Notice>
            )}
        </section>
    );
}
