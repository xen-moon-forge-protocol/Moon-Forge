/**
 * T4-29: a one-time, self-attested notice before the real-XNT games and Be the House. It is never shown on the
 * burn path. The acknowledgement and the optional break are stored only in this browser (localStorage); nothing
 * is sent anywhere, nobody is screened or verified, and clearing site data resets both.
 */
import { useState, type ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';

const ACK_KEY = 'moonforge_play_ack_v1';
const BREAK_KEY = 'moonforge_play_break_until';

/** Free, confidential help lines (plain links: nothing is loaded from them until you click). */
export const HELP_LINKS = [
    { label: 'Gambling Therapy (worldwide, multilingual)', url: 'https://www.gamblingtherapy.org/' },
    { label: 'Gamblers Anonymous', url: 'https://www.gamblersanonymous.org/' },
] as const;

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode: the gate simply shows again next time */ } };

export function playBreakUntil(): number {
    const v = Number(read(BREAK_KEY) || 0);
    return Number.isFinite(v) && v > Date.now() / 1000 ? v : 0;
}
export function playAcknowledged(): boolean { return read(ACK_KEY) === '1'; }

function HelpLinks() {
    return <>{HELP_LINKS.map((h, i) => <span key={h.url}>{i > 0 && ' · '}<a className="underline" href={h.url} target="_blank" rel="noopener noreferrer">{h.label}</a></span>)}</>;
}

/**
 * The gate covers entry actions only (place a bet, enter, create, join, deposit). `exits` (R1) is rendered below the
 * gate and below the break card, so a player who takes a break, or who cannot tick the boxes, can still withdraw their
 * own balance, leave Be the House, settle, cancel and take refunds. When the notice is acknowledged, `children`
 * already contain every exit, so `exits` is not repeated.
 */
export default function PlayGate({ children, exits }: { children: ReactNode; exits?: ReactNode }) {
    const [ack, setAck] = useState(playAcknowledged);
    const [breakUntil, setBreakUntil] = useState(playBreakUntil);
    const [c1, setC1] = useState(false);
    const [c2, setC2] = useState(false);
    const [c3, setC3] = useState(false);
    const [showBreak, setShowBreak] = useState(false);

    const takeBreak = (days: number) => {
        const until = Math.floor(Date.now() / 1000) + days * 86_400;
        write(BREAK_KEY, String(until));
        setBreakUntil(until);
        setShowBreak(false);
    };

    if (breakUntil > 0) {
        return (
            <>
                <div className="glass-card text-center">
                    <ShieldAlert className="w-8 h-8 text-amber-400 mx-auto mb-2" />
                    <p className="text-lunar-200">
                        You asked this browser to hide the games until <strong className="text-white">{new Date(breakUntil * 1000).toUTCString().slice(0, 22)} UTC</strong>.
                    </p>
                    <p className="text-xs text-lunar-500 mt-2">
                        The break is stored only on this device (clearing the browser's site data ends it early). Your balances and exits stay available below.
                        Free, confidential help: <HelpLinks />.
                    </p>
                </div>
                {exits}
            </>
        );
    }

    if (!ack) {
        return (
            <>
            <div className="glass-card max-w-3xl mx-auto">
                <div className="flex items-center gap-2 mb-3">
                    <ShieldAlert className="w-6 h-6 text-amber-400" />
                    <h3 className="font-space text-lg">Before you play or back the house</h3>
                </div>
                <ul className="list-disc list-inside text-sm text-lunar-300 space-y-1 mb-4">
                    <li>These are games of chance with a fixed house edge, prize draws and player-vs-player stakes. You can lose everything you stake, and Be the House shares in the bankroll's losses as well as its wins.</li>
                    <li>Gambling can be addictive. If it stops being fun, stop. Free, confidential help: <HelpLinks />.</li>
                    <li>Nobody screens, verifies or can exclude anyone here: the program is on a public chain and this page only talks to it. You alone are responsible for the laws that apply to you, including any tax on what you win.</li>
                    <li>Known unfixed issues are listed on each panel ("Known issues until the final upgrade") with their ids.</li>
                </ul>
                <div className="space-y-2 text-sm">
                    <label className="flex items-start gap-2 cursor-pointer"><input type="checkbox" className="mt-1" checked={c1} onChange={(e) => setC1(e.target.checked)} /><span>I am 18 or older, or the legal age for games of chance where I live.</span></label>
                    <label className="flex items-start gap-2 cursor-pointer"><input type="checkbox" className="mt-1" checked={c2} onChange={(e) => setC2(e.target.checked)} /><span>Real-money games of chance are legal where I am, and I am not a sanctioned person nor in a sanctioned jurisdiction.</span></label>
                    <label className="flex items-start gap-2 cursor-pointer"><input type="checkbox" className="mt-1" checked={c3} onChange={(e) => setC3(e.target.checked)} /><span>I can afford to lose what I stake or deposit here.</span></label>
                </div>
                <button className="btn-forge mt-4" disabled={!(c1 && c2 && c3)} onClick={() => { write(ACK_KEY, '1'); setAck(true); }}>Continue to the games</button>
                <p className="text-xs text-lunar-500 mt-3">
                    Your answers are saved only in this browser, once per device, and are never sent anywhere. Burning XEN on The Forge does not need this step,
                    and neither do your own exits: withdrawals, refunds and settling are below.
                </p>
            </div>
            {exits}
            </>
        );
    }

    return (
        <>
            {children}
            <div className="text-right text-xs text-lunar-500 mt-4">
                {showBreak ? (
                    <span>Hide the games on this device for{' '}
                        <button className="underline" onClick={() => takeBreak(1)}>24 h</button> ·{' '}
                        <button className="underline" onClick={() => takeBreak(7)}>7 days</button> ·{' '}
                        <button className="underline" onClick={() => takeBreak(30)}>30 days</button> ·{' '}
                        <button className="underline" onClick={() => setShowBreak(false)}>cancel</button>
                    </span>
                ) : (
                    <button className="underline hover:text-lunar-300" onClick={() => setShowBreak(true)}>Take a break from the games on this device</button>
                )}
            </div>
        </>
    );
}
