/**
 * The house keeper gate on the page (rules 3): reads the seat and every pending bet from X1 (src/v3/keeper.ts
 * keeperLiveness) and says plainly why house games and the Jackpot are shown or hidden, and how anyone can become the
 * keeper (dated opening, 28-day idle take-over). Fail-closed: while the read is pending or failed nothing is offered.
 */
import * as anchor from '@coral-xyz/anchor';
import { CheckCircle2, XCircle } from 'lucide-react';
import { usePoll } from '../../lib/hooks';
import { readConnection } from '../../lib/protocol';
import { PROJECT_LINKS } from '../../lib/constants';
import { AddrLink, Notice, Row, Xnt } from '../../components/ui';
import { loadV3Idl } from '../program';
import { betDiscriminator, keeperKeyOf, lastKeeperActivity, readKeeperLiveness, type Liveness } from '../keeper';
import { V3_PDAS } from '../constants';

export function useKeeperGate() {
    return usePoll(async () => {
        const { idl } = await loadV3Idl();
        return readKeeperLiveness(readConnection, (b) => anchor.utils.bytes.bs58.encode(b), betDiscriminator(idl as any));
    }, [], 30_000);
}
export type KeeperGate = ReturnType<typeof useKeeperGate>;
/** live only on a positive read (pending, failed or not live: false) */
export const gateLive = (g: KeeperGate) => !!g.data && g.data.liveness.live;
export const gateLiveness = (g: KeeperGate): Liveness | null => g.data?.liveness ?? null;

export function KeeperStatusCard({ gate, what }: { gate: KeeperGate; what: string }) {
    const d = gate.data;
    if (!d && gate.loading) return <div className="glass-card text-sm text-lunar-400">Reading the house keeper seat and the pending bets on X1…</div>;
    if (!d) return <Notice kind="warn">Could not read the house keeper seat on X1 ({gate.error ?? 'no answer'}): {what} {what.endsWith('s') ? 'are' : 'is'} not offered until it can be checked.</Notice>;
    const { liveness, opening, seat } = d;
    const keeper = keeperKeyOf(seat);
    return (
        <div className="glass-card space-y-3">
            <h3 className="font-space text-lg">{liveness.live ? 'House keeper: live' : `${what[0].toUpperCase()}${what.slice(1)} hidden: no live house keeper`}</h3>
            <p className="text-sm text-lunar-300">
                {liveness.live
                    ? `The chain shows a keeper that is armed, bonded and keeping its service levels, so ${what} ${what.endsWith('s') ? 'are' : 'is'} offered. This is re-checked every 30 seconds from X1, never from a setting.`
                    : `${what[0].toUpperCase()}${what.slice(1)} ${what.endsWith('s') ? 'are' : 'is'} shown only while the chain shows a live keeper. Bets and entries already made keep their exits below.`}
            </p>
            <ul className="text-sm space-y-1">
                {liveness.checks.map((c) => (
                    <li key={c.id} className="flex items-start gap-2">
                        {c.ok ? <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" /> : <XCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />}
                        <span className={c.ok ? 'text-lunar-300' : 'text-white'}>{c.text}</span>
                    </li>
                ))}
            </ul>
            <div className="grid md:grid-cols-2 gap-x-8 text-sm">
                <Row label="Keeper seat"><AddrLink address={V3_PDAS.houseKeeper} /></Row>
                <Row label="Keeper key">{keeper ? <AddrLink address={keeper} /> : 'none'}</Row>
                <Row label="Bond"><Xnt lamports={seat ? Number(seat.bond) : null} digits={2} /></Row>
                <Row label="Last keeper activity">{seat ? lastKeeperActivity(seat) : '--'}</Row>
            </div>
            <div className="p-3 rounded-lg bg-space-700/40 text-sm text-lunar-300 space-y-2">
                <div className="text-white font-bold">Anyone can become the keeper</div>
                <p>{opening.text}</p>
                <p>
                    A keeper commits a hash chain before any bet and posts its own bond (at least 20 XNT). If it stops, its bond pays the players: a bet it does
                    not reveal in about a day is paid as a win, a bet nobody anchors in about 3 minutes is refunded in full. The keeper receives a settle tip of
                    at most 0.0005 XNT per settled bet from the reward pool. The open-source keeper (<code>npm run keeper-arm</code>, then <code>npm run keeper</code>,
                    or <code>npm run keeper-take</code> for an idle seat) is in the{' '}
                    <a className="text-forge-orange hover:underline" href={PROJECT_LINKS.oracle} target="_blank" rel="noopener noreferrer">oracle folder</a> of the repository; it runs with any funded key.
                </p>
            </div>
        </div>
    );
}
