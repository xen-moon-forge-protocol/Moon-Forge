/**
 * The public counter on the page: XEN removed from supply through Moon Forge per chain, and the XNT the published epochs
 * set aside for burners (lib/counter.ts). Reads counter.json (written at every site build from the epoch files) when it
 * matches the newest epoch of epochs/index.json, otherwise recomputes it from the epoch files themselves.
 */
import { Flame } from 'lucide-react';
import { usePoll } from '../lib/hooks';
import { fetchEpochFile, fetchEpochIndex } from '../lib/protocol';
import { formatNumber } from '../lib/constants';
import { counterMatchesIndex, summarizeEpochFiles, type PublicCounter as Counter } from '../lib/counter';
import { Row } from './ui';

const base = () => ((import.meta as any).env?.BASE_URL as string | undefined) ?? '/Moon-Forge/';

export async function loadPublicCounter(): Promise<Counter> {
    const index = await fetchEpochIndex();
    const ids = (index.epochs ?? []).map((e) => e.epoch);
    const newest = ids.length ? Math.max(...ids) : null;
    try {
        const r = await fetch(`${base()}counter.json`, { cache: 'no-store' });
        if (r.ok) {
            const c = await r.json();
            if (counterMatchesIndex(c, newest)) return c as Counter;
        }
    } catch { /* recompute below */ }
    const files = await Promise.all(ids.map((n) => fetchEpochFile(n)));
    return summarizeEpochFiles(files);
}

const xenText = (x: string) => formatNumber(Number(x), 0);

export default function PublicCounter({ compact = false }: { compact?: boolean }) {
    const c = usePoll(loadPublicCounter, [], 0);
    const d = c.data;
    if (compact) {
        return (
            <p className="text-sm text-lunar-300">
                <Flame className="inline w-4 h-4 text-forge-orange mr-1" />
                {d ? <>So far, published epochs count <strong className="text-white">{xenText(d.xen)} XEN</strong> removed from supply through Moon Forge
                    {' '}on {d.chains.length} chain{d.chains.length === 1 ? '' : 's'}, and set aside <strong className="text-white">{formatNumber(Number(d.xntSetAside), 4)} XNT</strong> for burners
                    {' '}(<a className="text-forge-orange hover:underline" href={`${base()}counter.json`} target="_blank" rel="noopener noreferrer">counter.json</a>).</>
                    : c.error ? 'The public counter could not be loaded.' : 'Loading the public counter…'}
            </p>
        );
    }
    return (
        <section className="glass-card">
            <div className="flex items-center gap-2 mb-2"><Flame className="w-5 h-5 text-forge-orange" /><h2 className="font-space text-xl">Public counter</h2></div>
            <p className="text-sm text-lunar-400 mb-3">
                Computed only from the published epoch files (each hash-committed on X1). Machine-readable copy:{' '}
                <a className="text-forge-orange hover:underline" href={`${base()}counter.json`} target="_blank" rel="noopener noreferrer">counter.json</a>.
            </p>
            {c.error && <p className="text-sm text-red-300">Could not load the epoch files: {c.error}</p>}
            {d && (
                <>
                    <div className="grid md:grid-cols-2 gap-x-8 text-sm">
                        <Row label="XEN removed from supply (all chains)">{xenText(d.xen)} XEN</Row>
                        <Row label="Burns counted">{d.burns}</Row>
                        <Row label="XNT set aside for burners by published epochs">{formatNumber(Number(d.xntSetAside), 4)} XNT</Row>
                        <Row label="Epochs counted / newest">{d.epochs} / {d.newestEpoch !== null ? `#${d.newestEpoch}` : '--'}</Row>
                    </div>
                    {d.chains.length > 0 && (
                        <div className="overflow-x-auto mt-3">
                            <table className="w-full text-sm">
                                <thead><tr className="text-left text-lunar-400 border-b border-white/10"><th className="py-1 pr-3">Chain</th><th className="py-1 pr-3">XEN removed</th><th className="py-1">Burns</th></tr></thead>
                                <tbody>
                                    {d.chains.map((ch) => (
                                        <tr key={ch.chainId} className="border-b border-white/5"><td className="py-1 pr-3">{ch.name}</td><td className="py-1 pr-3">{xenText(ch.xen)}</td><td className="py-1">{ch.burns}</td></tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <ul className="text-xs text-lunar-500 mt-3 list-disc list-inside space-y-1">{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>
                </>
            )}
        </section>
    );
}
