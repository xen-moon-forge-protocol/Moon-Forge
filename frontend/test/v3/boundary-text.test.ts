/**
 * Round 4 defaults on the boundary (C-14) and the games (D-39), as the site states them under rules 3:
 *  - the boundary notice names the planned release that ends the Forge's hold, and says that a burn made after the last
 *    v2 publish transaction is never paid under the current rules (a late upgrade only delays it to the first v3 epoch);
 *  - house games and the Jackpot are offered only while the chain shows a live keeper (r9: src/v3/keeper.ts keeperLiveness,
 *    read from X1 on every visit; no constant a later release has to flip, since nobody may change the site after the
 *    freeze); a seat needs a keeper key and a bond of at least 20 XNT among the other checks;
 *  - the keeper texts follow the round-4 program: a house stall is paid from the keeper bond, and the settle tip is a
 *    running cost of the pool.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { boundaryText, V3_BOUNDARY } from '../../src/v3/facts-v3';
import { artifactRulesS7, gamesS7 } from '../../src/v3/facts-s7';
import { houseNoBetsNoticeShown, jackpotOffered, keeperSeatReady, newHouseBetsOffered, type Liveness } from '../../src/v3/keeper';
import { KEEPER_BOND_MIN } from '../../src/v3/constants';

describe('C-14: the boundary texts', () => {
    it('before the transaction: the hold, its planned end, and never paid under the current rules', () => {
        const t = boundaryText({ date: '2026-11-15', lastV2PublishTx: null, releaseUtc: '2026-11-16 06:00' });
        expect(t.rest).toContain('From 00:00 UTC on 2026-11-15 this page holds new burns');
        expect(t.rest).toContain('(planned for 2026-11-16 06:00 UTC)');
        expect(t.rest).toContain('no epoch under the current rules pays them');
        expect(boundaryText({ date: '2026-11-15', lastV2PublishTx: null }).rest).not.toContain('planned for 2026-11-16');
    });
    it('after the transaction: a late upgrade delays those burns to the first v3 epoch, with their own time', () => {
        const t = boundaryText({ date: '2026-11-15', lastV2PublishTx: '5'.repeat(88) });
        expect(t.lead).toBe('Since the publish transaction');
        expect(t.rest).toContain('keep their own time and wait for the first epoch built under the v3 rules');
        expect(t.rest).toContain('no epoch under the current rules pays them');
    });
    it('is not set today (the site behaves as the live release)', () => {
        expect(V3_BOUNDARY).toBeNull();
    });
});

describe('D-39: house games and the Jackpot after the upgrade', () => {
    const seat = (bond: bigint) => ({ keeper: new PublicKey('11111111111111111111111111111112'), bond } as any);
    const L = (live: boolean): Liveness => ({ live, checks: [], failed: [] });
    it('r9: house games and the Jackpot follow the chain-read liveness only (no announced switch)', () => {
        expect(KEEPER_BOND_MIN).toBe(20_000_000_000n);
        for (const l of [null, L(false)]) {
            expect(jackpotOffered(l)).toBe(false);
            expect(newHouseBetsOffered(l)).toBe(false);
        }
        expect(jackpotOffered(L(true))).toBe(true);
        expect(newHouseBetsOffered(L(true))).toBe(true);
        expect(keeperSeatReady(seat(KEEPER_BOND_MIN))).toBe(true);
        expect(keeperSeatReady(seat(KEEPER_BOND_MIN - 1n))).toBe(false);
        expect(keeperSeatReady({ keeper: PublicKey.default, bond: KEEPER_BOND_MIN } as any)).toBe(false);
    });
    it('the texts state the chain-read gate (armed, 20 XNT bond, recent, service levels) and that the sealed games need no keeper', () => {
        const gate = 'only while the chain shows a live keeper: armed, bonded with at least 20 XNT, not idle for 28 days and keeping its service levels on the bets pending now';
        for (const t of [gamesS7.house, gamesS7.jackpot, gamesS7.intro, gamesS7.houseNoBets]) expect(t).toContain(gate);
        expect(gamesS7.jackpotOff).toContain('a Jackpot round that ends refunds every entry');
        for (const t of [gamesS7.duel, gamesS7.wars]) expect(t).toContain('No Artifact and no keeper are needed');
        for (const t of Object.values(gamesS7)) expect(t).not.toMatch(/service levels for a week|KEEPER_SLA_MET/);
        expect(gamesS7.house).toContain('without a keeper seat the program takes no house bet');
        for (const t of Object.values(gamesS7)) {
            expect(t).not.toMatch(/offers it only while a keeper seat holds/);
            expect(t).not.toMatch(/no keeper seat holds a bond/);
            expect(t).not.toMatch(/closed for good/);
        }
    });
    it('the keeper texts follow the round-4 program (stall paid from the bond; settle tip a running cost of the pool)', () => {
        expect(gamesS7.house).toContain('paid for by the keeper’s bond');
        // r4-fix (review r4 finding 1): an unanchored bet comes back whole and still costs the bond its stake
        expect(gamesS7.house).toContain('its whole stake back if it was never anchored, and the bond then loses the stake too');
        expect(gamesS7.house).not.toContain('refunded, not lost');
        expect(gamesS7.fees).toContain('settle tip of at most 0.0005 XNT');
        expect(gamesS7.fees).toContain('a running cost of the pool');
    });
});

describe('r7 audit F1/F17: the Artifact rebate and Genesis texts after the upgrade', () => {
    it('the extra-pot text states the WORDING bound and never the banned "own contribution" or "2× what you paid" forms', () => {
        expect(artifactRulesS7.extraPot).not.toMatch(/own forge contribution|what they paid in|2× what/);
        expect(artifactRulesS7.extraPot).toContain('tied to the holder’s own burns');
        expect(artifactRulesS7.extraPot).toContain('counted use is at most 1% of the price paid per eligible Artifact per week');
        expect(artifactRulesS7.extraPot).toContain('so at most 2% of the price paid per Artifact per week');
        expect(artifactRulesS7.extraPot).toContain('only in the first 52 weeks after the Artifact was forged');
        expect(artifactRulesS7.extraPot).toContain('A holder who does not burn receives nothing from it');
        for (const t of Object.values(artifactRulesS7)) expect(t).not.toMatch(/own forge contribution|what they paid in|2× what/);
    });
    it('the Genesis text names the official claim page without denying that other clients can call the program', () => {
        expect(artifactRulesS7.genesis).toContain('The only official Genesis claim page is this site’s Artifacts page');
        expect(artifactRulesS7.genesis).not.toContain('The only Genesis claim is');
    });
});

describe('r7 audit F8: Be the House tells a depositor when no house bet is accepted', () => {
    it('the notice is shown whenever house games are not offered (no live keeper, or the read is pending or failed)', () => {
        expect(houseNoBetsNoticeShown(null)).toBe(true);
        expect(houseNoBetsNoticeShown({ live: false, checks: [], failed: [] })).toBe(true);
        expect(houseNoBetsNoticeShown({ live: true, checks: [], failed: [] })).toBe(false);
    });
    it('the notice states the gate, that it may not happen, and the withdrawal path', () => {
        expect(gamesS7.houseNoBets).toContain('No house bet is accepted while no house keeper is armed');
        expect(gamesS7.houseNoBets).toContain('that may not happen');
        expect(gamesS7.houseNoBets).toContain('request, wait 24 h, withdraw within the next 24 h');
        expect(gamesS7.houseNoBets).not.toMatch(/closed for good|earn|yield|return/i);
    });
    it('BankTabV3 renders the notice above the panel', () => {
        const src = readFileSync(new URL('../../src/v3/ui/GamesV3.tsx', import.meta.url), 'utf8');
        const tab = src.slice(src.indexOf('export function BankTabV3'), src.indexOf('export function WarsTabV3'));
        expect(tab).toContain('{houseNoBetsNoticeShown(gateLiveness(gate)) && <Notice kind="warn">{gamesS7.houseNoBets}</Notice>}');
        expect(tab.indexOf('houseNoBetsNoticeShown(')).toBeLessThan(tab.indexOf('<BeTheHouse'));
    });
});
