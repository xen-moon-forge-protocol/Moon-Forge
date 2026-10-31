/**
 * The two pots after the final upgrade (rules 3 only): the base pot (reward_vault: every burner is paid from it by the
 * same rule) and the extra pot (extra_vault, counted by ExtraState: forged Artifacts' rebate). Every number is read from
 * X1: the free reward pool (lib/protocol.ts fetchProtocol) and ExtraState (src/v3/layout.ts). The extra-epoch cap is the
 * program's own bound (src/v3/extra.ts extraBound, a mirror of extra.rs extra_bound).
 */
import { Row, Xnt } from '../../components/ui';
import { artifactRulesS7, forgeSplitS7 } from '../facts-s7';
import { EXTRA_BACKING_BOUND_BPS, EXTRA_MAX_WEEKS, EXTRA_RELEASE_BPS } from '../constants';
import { extraBound } from '../extra';
import type { ExtraStateView } from '../layout';

const n = (v: bigint) => Number(v);
const pct = (bps: bigint) => `${Number(bps) / 100}%`;

export default function TwoPotCard({ rewardFree, extra, compact = false }: { rewardFree: number | null; extra: ExtraStateView | null; compact?: boolean }) {
    const bound = extra ? extraBound(extra, 1) : null;
    const free = extra ? (extra.accounted > extra.reserved ? extra.accounted - extra.reserved : 0n) : null;
    return (
        <div className="glass-card mb-6">
            <h2 className="font-space text-xl mb-3">Two pots</h2>
            <div className="grid md:grid-cols-2 gap-4">
                <div className="bg-space-700/40 rounded-xl p-4">
                    <div className="text-sm text-white font-bold mb-1">Base pot (reward pool)</div>
                    <p className="text-xs text-lunar-400 mb-2">
                        Pays every burner by the same rule, Artifact or not. Receives {forgeSplitS7.basePotPct}% of each forge, 2% of each native sale and the game edges.
                    </p>
                    <Row label="Free now"><Xnt lamports={rewardFree} digits={2} /></Row>
                </div>
                <div className="bg-space-700/40 rounded-xl p-4">
                    <div className="text-sm text-white font-bold mb-1">Extra pot (forged Artifacts’ rebate)</div>
                    <p className="text-xs text-lunar-400 mb-2">Receives {forgeSplitS7.extraPotPct}% of each forge and nothing else (no sale fee, no game cut).</p>
                    <Row label="Counted by the program"><Xnt lamports={extra ? n(extra.accounted) : null} digits={2} /></Row>
                    <Row label="Reserved for open extra epochs"><Xnt lamports={extra ? n(extra.reserved) : null} digits={2} /></Row>
                    <Row label="Free"><Xnt lamports={free !== null ? n(free) : null} digits={2} /></Row>
                    {!compact && <>
                        <Row label="Program cap for a one-week extra epoch"><>{bound ? <Xnt lamports={n(bound.cap)} digits={2} /> : '--'}</></Row>
                        <Row label="Paid so far / forge inflows"><>{extra ? <><Xnt lamports={n(extra.totalPaid)} digits={2} /> / <Xnt lamports={n(extra.totalIn)} digits={2} /></> : '--'}</></Row>
                        <Row label="Last extra epoch">{extra ? (extra.lastEpoch > 0n ? `#${extra.lastEpoch.toString()}` : 'none yet') : '--'}</Row>
                    </>}
                </div>
            </div>
            <p className="text-xs text-lunar-500 mt-3">{artifactRulesS7.extraPot}</p>
            {!compact && <p className="text-xs text-lunar-500 mt-1">
                Program bounds: an extra epoch releases at most {pct(EXTRA_RELEASE_BPS)} of the pot’s free balance, and at most {pct(EXTRA_BACKING_BOUND_BPS)} of
                the live forged floors (plus the floors that left since the last publication) per week of its window, up to {EXTRA_MAX_WEEKS} weeks; claims open
                48 h after each publication and stay open 90 days, then the rest goes back to the extra pot.
            </p>}
        </div>
    );
}
