/**
 * Fail-safe for the text pages (Home, Start, FAQ, Transparency, Whitepaper) between an event and the regenerated texts:
 * once rules detection reads the upgraded program (rules 3) or the v3 reward rules (rewards 3: a version-3 epoch file, or
 * the announced boundary transaction as the newest publication), these pages still carry text written for the rules
 * before it. This banner says so, so no old rule reads as current, until the release that regenerates them (facts-s7 /
 * facts-v3, prerender --facts) replaces the text. Renders nothing before either event.
 *
 * The Forge and Mission Control are app pages (not regenerated): they switch their own texts by detection, and this
 * banner is only a fallback there, worded for what can remain on them (texts about epochs, bets and rounds from before).
 */
import { Link, useLocation } from 'react-router-dom';
import { useDetection } from '../detect';
import { V3_BOUNDARY } from '../facts-v3';

const TEXT_PAGES = ['/', '/start', '/faq', '/transparency', '/whitepaper', '/donate'];
const APP_PAGES = ['/forge', '/missions'];

export default function RulesChangedBanner() {
    const d = useDetection();
    const { pathname } = useLocation();
    const rules3 = d.rules === 3;
    const rewards3 = d.rewards === 3;
    if (!rules3 && !rewards3) return null;
    const path = pathname.replace(/\/+$/, '') || '/';
    const since = V3_BOUNDARY ? ` since the publish transaction of ${V3_BOUNDARY.date} (UTC)` : '';
    if (APP_PAGES.includes(path)) {
        // the Forge shows the v3 quote itself under rewards 3; only the program line can still apply there
        const showRewards = rewards3 && path === '/missions';
        if (!rules3 && !showRewards) return null;
        return (
            <div role="note" className="mb-6 p-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-200 text-sm">
                {rules3 && <p>The final program upgrade is live. Where this page still mentions Forge Drops, the Artifact boost, chips or the arena ticket, it refers to epochs, bets and rounds from before the upgrade; the current rules are on the <Link to="/artifacts" className="underline">Artifacts</Link> and <Link to="/games" className="underline">Games</Link> pages.</p>}
                {showRewards && <p className={rules3 ? 'mt-1' : ''}>New burns are paid under the v3 reward rules{since}. Epochs published before keep the rules they were built with.</p>}
            </div>
        );
    }
    if (!TEXT_PAGES.includes(path)) return null;
    return (
        <div role="note" className="mb-6 p-3 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-200 text-sm">
            {rules3 && <p>The final program upgrade is live. Where this page describes chips, the Burn Lottery tickets, the arena ticket, the 50/40/5/5 forge split or the rising Artifact price, it describes the program before the upgrade: the current rules are on the <Link to="/artifacts" className="underline">Artifacts</Link> and <Link to="/games" className="underline">Games</Link> pages until this page is regenerated.</p>}
            {rewards3 && <p className={rules3 ? 'mt-1' : ''}>New burns are paid under the v3 reward rules{since}. Where this page describes the v2 scoring (budget split by score, Artifact boost, Forge Drops), it describes burns made before that: the current rules and the quote are on <Link to="/forge" className="underline">The Forge</Link> until this page is regenerated.</p>}
        </div>
    );
}
