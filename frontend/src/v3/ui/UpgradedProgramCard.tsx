/**
 * Transparency, rules 3 only: the accounts the final upgrade added, read live, and the sha256 of the IDL this site
 * bundles for the upgraded program (compare it with the hash published in UPGRADE-2026-11.md). Loads the new IDL lazily.
 */
import { Cpu } from 'lucide-react';
import { usePoll } from '../../lib/hooks';
import { readConnection } from '../../lib/protocol';
import { AddrLink, Row, Xnt } from '../../components/ui';
import { loadV3Idl } from '../program';
import { fetchHouseKeeper } from '../keeper';
import { readRules } from '../detect';
import { V3_PDAS } from '../constants';
import { MARKET_FEES_LINE } from '../market';
import { forgeSplitS7, gamesS7 } from '../facts-s7';

export default function UpgradedProgramCard() {
    const idl = usePoll(() => loadV3Idl(), [], 0);
    const keeper = usePoll(() => fetchHouseKeeper(readConnection), [], 120_000);
    const extra = usePoll(() => readRules(readConnection).then((r) => r.extraState), [], 120_000);
    return (
        <section className="glass-card">
            <div className="flex items-center gap-2 mb-2"><Cpu className="w-5 h-5 text-forge-gold" /><h2 className="font-space text-xl">Upgraded program</h2></div>
            <div className="grid md:grid-cols-2 gap-x-8 text-sm">
                <Row label="Extra pot state"><AddrLink address={V3_PDAS.extraState} /></Row>
                <Row label="Extra pot vault"><AddrLink address={V3_PDAS.extraVault} /></Row>
                <Row label="House keeper seat"><AddrLink address={V3_PDAS.houseKeeper} /></Row>
                <Row label="Oracle seat"><AddrLink address={V3_PDAS.oracleSeat} /></Row>
                <Row label="Extra pot counted"><Xnt lamports={extra.data ? Number(extra.data.accounted) : null} digits={2} /></Row>
                <Row label="Keeper bond">{keeper.data ? <Xnt lamports={Number(keeper.data.bond)} digits={2} /> : keeper.loading ? '--' : 'no keeper seat'}</Row>
                <Row label="Bundled IDL">{idl.data ? `${idl.data.instructions} instructions` : idl.error ? 'could not load' : '--'}</Row>
                <Row label="IDL sha256"><span className="font-mono text-xs break-all">{idl.data ? idl.data.sha256 : '--'}</span></Row>
            </div>
            <p className="text-xs text-lunar-500 mt-3">
                Forge price: {forgeSplitS7.floorPct}% floor, {forgeSplitS7.basePotPct}% base pot, {forgeSplitS7.extraPotPct}% extra pot, {forgeSplitS7.architectPct}% architect, 0% lottery. {MARKET_FEES_LINE} {gamesS7.fees} {gamesS7.limits}
            </p>
        </section>
    );
}
