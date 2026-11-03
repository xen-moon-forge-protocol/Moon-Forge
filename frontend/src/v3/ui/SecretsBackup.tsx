/**
 * The explicit backup of the sealed-game secrets kept in this browser (src/v3/sealed.ts): export them as one JSON text
 * (download or copy) and import them on this or another browser. A restored record never replaces a different one.
 * The text holds secrets (and, for Moon Wars, the small move key that pays move fees): keep it private.
 */
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { PROGRAM_ID_B58 } from '../../lib/constants';
import { Notice } from '../../components/ui';
import { browserSecrets } from '../sealed';

export default function SecretsBackup({ compact = false }: { compact?: boolean }) {
    const store = browserSecrets();
    const [open, setOpen] = useState(false);
    const [text, setText] = useState('');
    const [msg, setMsg] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
    const [, setTick] = useState(0);
    const count = store.list().length;

    const exportNow = () => {
        const t = store.exportSecrets(PROGRAM_ID_B58);
        setText(t);
        setOpen(true);
        try {
            const url = URL.createObjectURL(new Blob([t], { type: 'application/json' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `moonforge-secrets-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 5_000);
            setMsg({ kind: 'info', text: `Backup of ${count} record(s) prepared. If no file was saved, copy the text below and keep it somewhere private.` });
        } catch {
            setMsg({ kind: 'info', text: 'Copy the text below and keep it somewhere private.' });
        }
    };
    const copy = async () => {
        try { await navigator.clipboard.writeText(text); setMsg({ kind: 'info', text: 'Copied.' }); } catch { setMsg({ kind: 'error', text: 'Copy failed: select the text and copy it by hand.' }); }
    };
    const importNow = (t: string) => {
        try {
            const r = store.importSecrets(t, PROGRAM_ID_B58);
            setMsg({ kind: r.conflicts.length ? 'error' : 'info', text: `Restored ${r.added}, already here ${r.same}${r.refused ? `, refused ${r.refused} malformed` : ''}${r.conflicts.length ? `; NOT replaced (a different secret is already stored): ${r.conflicts.join(', ')}` : ''}.` });
            setTick((x) => x + 1);
        } catch (e: any) {
            setMsg({ kind: 'error', text: String(e?.message ?? e) });
        }
    };
    const onFile = async (f: File | undefined) => { if (f) importNow(await f.text()); };

    return (
        <div className={`rounded-xl border border-white/10 ${compact ? 'p-3' : 'p-4'} space-y-2`}>
            <div className="flex flex-wrap items-center gap-2">
                <KeyRound className="w-4 h-4 text-forge-gold" />
                <span className="text-sm text-white">Sealed-game secrets in this browser: {count}</span>
                <button className="btn-outline !px-3 !py-1 text-xs ml-auto" onClick={exportNow} disabled={count === 0}>Back up</button>
                <button className="btn-outline !px-3 !py-1 text-xs" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Restore'}</button>
            </div>
            {!compact && (
                <p className="text-xs text-lunar-500">
                    Your sealed duel elements, Moon Wars entropy and secrets, and each match's move key live only in this browser (localStorage). Clearing site data,
                    a private window or another device loses them, and a sealed choice that cannot be revealed loses its game. Back them up after each create or
                    join; the file holds secrets, so keep it private. The records have the agent kit's format, so the kit can use them too.
                </p>
            )}
            {open && (
                <div className="space-y-2">
                    <textarea className="input-forge !text-xs font-mono h-28" value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste a backup here to restore it" aria-label="Secrets backup text" />
                    <div className="flex flex-wrap gap-2">
                        <button className="btn-outline !px-3 !py-1 text-xs" disabled={!text} onClick={copy}>Copy</button>
                        <button className="btn-forge !px-3 !py-1 text-xs" disabled={!text} onClick={() => importNow(text)}>Restore from the text</button>
                        <label className="btn-outline !px-3 !py-1 text-xs cursor-pointer">Restore from a file
                            <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
                        </label>
                    </div>
                </div>
            )}
            {msg && <Notice kind={msg.kind === 'error' ? 'error' : 'info'}>{msg.text}</Notice>}
        </div>
    );
}
