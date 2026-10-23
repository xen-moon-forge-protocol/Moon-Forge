/**
 * X-082: known, not-yet-fixed findings, shown on every games panel until the final upgrade (the commit that
 * ships the upgrade removes them). Ids are stable and unique and match docs/KNOWN-ISSUES.md: GAM-1 slot-hash
 * draws, GAM-2 Be the House quotes, GAM-3 Predictions, GAM-4 Moon Wars creator edge, GAM-5 Moon Wars move key,
 * GAM-6 Duel cancel race, GAM-7 settle window, GAM-8 lottery chip dilution. Four findings keep the games review's
 * own labels, in the register too (GAM-M3 matured withdrawal never expires, GAM-L1 breaker ignores open bets,
 * GAM-L3 keeper flooding, GAM-X151 unsettled bets become LP income).
 * Planned fixes name no rules-3 detail (prices, splits, chip values, new caps or windows) before the final upgrade ships.
 */
import { PROJECT_LINKS } from '../../lib/constants';
import { P } from '../../lib/protocol';

export const KNOWN_ISSUES_DATE = '2026-10-22';

export const KNOWN_ISSUES = {
    'GAM-1': {
        severity: 'High',
        title: 'Block producers can steer slot-hash draws',
        text: 'House games, the Jackpot, the Burn Lottery and the Moon Wars deck shuffle take their randomness from the hash of a future slot. The validator producing that slot (a leader holds 4 slots in a row) can choose between candidate hashes or withhold its block, and the first entrant of a Jackpot or lottery round sets when the round ends, so a validator can line a draw up with its own slots. Exposure is capped per bet and per day, but in the review model a steering validator wins a coin flip about 75% of the time and can drain roughly 10% of the bankroll per day.',
        fix: 'keeper hash-chain randomness (commit-reveal with a bond) for every draw in the final upgrade.',
    },
    'GAM-2': {
        severity: 'High',
        title: 'Be the House deposits and withdrawals can be griefed through open bets',
        text: 'Withdrawals are priced as if every open bet wins and deposits as if every open bet loses; the reserve is released only when bets settle. Someone who opens many high-multiplier bets just before your withdrawal lowers what you receive (in the review’s case a 10% LP got about 80% of their value), and the mirror image makes a deposit overpay by up to about 23%. This page now refuses deposits and withdrawals while open bets reserve more than 1% of the bankroll, unless you override.',
        fix: 'the aggregate exposure cap is lowered in the final upgrade (the new value is published with its changelog); the agent kit applies the same 1% guard.',
    },
    'GAM-M3': {
        severity: 'Medium',
        title: 'A matured withdrawal request never expires',
        text: 'An LP can hold an unlocked withdrawal request indefinitely and leave the moment the bankroll turns against the others; in the review’s two-day drain the armed LP left with -2% while another lost -17%.',
        fix: 'a matured request must be used within a fixed window (then renewed) in the final upgrade; the window is published with its changelog.',
    },
    'GAM-L1': {
        severity: 'Low',
        title: 'The daily breaker ignores open bets',
        text: 'The 10%-per-day loss limit is checked on the bankroll before open bets are counted, so a day can end worse than -10% when several large open bets win at once.',
        fix: 'open bets are counted as won by the breaker in the final upgrade.',
    },
    'GAM-L3': {
        severity: 'Low',
        title: 'The public keeper can be flooded',
        text: 'The keeper settles at most 60 bets per pass, in no particular order, so a flood of tiny bets can let someone else\'s winning bet expire unsettled (see GAM-7). This page settles your own bet right after the next slot: keep it open until the result shows.',
        fix: 'winners first, oldest first, in batches, in the final upgrade.',
    },
    'GAM-X151': {
        severity: 'Disclosure',
        title: 'An unsettled bet counts as lost and its stake stays with the LPs',
        text: 'Today a house bet nobody settles within about 3 minutes counts as lost, even on a winning roll, and its stake stays in the bankroll. LPs, the project\'s own seed deposit included, gain from every missed settlement, and the project also runs the fallback keeper.',
        fix: 'the final upgrade refunds unsettled bets instead of counting them as lost.',
    },
    'GAM-3': {
        severity: 'Medium',
        title: 'Predictions rounds can be blocked and steered',
        text: 'One 200 XNT entry fills a round\'s pot and forces a refund for free; the 15-minute TWAP of a thin pool can be moved for a few dollars; one push can decide two rounds; late entries have an edge. Predictions are no longer offered on this site: only claiming and refunds of old entries remain.',
        fix: 'rounds are redesigned in the final upgrade and stay off this site.',
    },
    'GAM-4': {
        severity: 'Medium',
        title: 'Moon Wars: the creator moves first and has the edge',
        text: 'With two equal policies the creator wins about 58% of matches; a creator who never attacks still wins on fatigue; an abandoned offer can be started by anyone and its creator then loses on time; an expired start can be re-rolled by waiting.',
        fix: 'first player drawn from the seed and a first-turn grace period in the final upgrade.',
    },
    'GAM-5': {
        severity: 'Live bug',
        title: 'Moon Wars: the browser move key runs dry',
        text: 'The move key is funded with 0.005 XNT and each move costs about 0.002 XNT, so a match can be lost on time after two moves, and the leftover is not returned. Creating and joining real-XNT matches is paused on this site; moves, cancels, timeout claims and payouts of existing matches still work.',
        fix: 'the wallet pays move fees and the leftover is refunded in the final upgrade; real matches reopen only after the keeper service has met its service levels for a week.',
    },
    'GAM-6': {
        severity: 'Low',
        title: 'Artifact Duel: the creator can dodge a losing match-up',
        text: 'The joiner\'s element travels in plain text while the creator\'s stays hidden until reveal. A creator who sees the join before it lands (for example from a validator, or by out-bidding it on priority fee) can cancel the duel in the same slot; the review estimates a +24%-of-stake edge for a creator who does this.',
        fix: 'the joiner also commits a hidden element in the final upgrade.',
    },
    'GAM-7': {
        severity: 'Medium',
        title: 'A bet not settled within about 3 minutes counts as lost',
        text: 'A house bet must be settled within about 3 minutes (the slot-hash window) or it counts as lost even on a winning roll. This page settles right after the next slot, but switching to a wallet app or locking a phone screen can suspend it, and the public keeper cannot be relied on for this window. Bet from a desktop browser that stays open, or keep stakes small on mobile.',
        fix: 'the final upgrade refunds a bet that is not settled in time instead of counting it as lost.',
    },
    'GAM-8': {
        severity: 'Medium',
        title: 'Chip farming dilutes the Burn Lottery prize',
        text: `House-game wagering credits 1 chip per ${P.chipPerWageredXnt} XNT wagered, so a chip costs far less than a 1 XNT ticket and farmed chips dilute every ticket; a round with a single entrant pays 50% of the vault for one chip. Assume a ticket is worth less than its price.`,
        fix: 'the final upgrade changes the Burn Lottery and chips; what changes is published with the upgrade notice, at least 7 days ahead.',
    },
} as const;

export type KnownIssueId = keyof typeof KNOWN_ISSUES;

export default function KnownIssues({ ids, className = '' }: { ids: readonly KnownIssueId[]; className?: string }) {
    return (
        <details className={`rounded-xl border border-amber-500/30 bg-amber-500/5 text-sm ${className}`}>
            <summary className="cursor-pointer px-3 py-2 text-amber-200">
                Known issues until the final upgrade ({ids.length}) · notice dated {KNOWN_ISSUES_DATE}
            </summary>
            <ul className="px-3 pb-2 space-y-2 text-lunar-300">
                {ids.map((id) => {
                    const k = KNOWN_ISSUES[id];
                    return (
                        <li key={id} id={`known-${id}`}>
                            <span className="font-mono text-xs text-amber-300">{id}</span>{' '}
                            <span className="text-xs text-lunar-500">{k.severity}</span> · <strong className="text-white">{k.title}.</strong>{' '}
                            {k.text} <em className="text-lunar-400">Planned fix: {k.fix}</em>
                        </li>
                    );
                })}
            </ul>
            <p className="px-3 pb-3 text-xs text-lunar-500">
                These findings are known and unfixed today; play or deposit only if you accept them. Full register with status:{' '}
                <a href={PROJECT_LINKS.knownIssuesMd} target="_blank" rel="noopener noreferrer" className="underline">docs/KNOWN-ISSUES.md</a> and{' '}
                <a href={PROJECT_LINKS.securityMd} target="_blank" rel="noopener noreferrer" className="underline">SECURITY.md</a>.
            </p>
        </details>
    );
}
