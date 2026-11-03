/**
 * The rules-3 GAME mirror (src/v3/games-constants.ts) against programs/moon-forge/src/constants.rs (mainnet values; a
 * `#[cfg(feature = "localnet")]` definition is skipped). A change of the program build fails here before it reaches a page.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as G from '../../src/v3/games-constants';

const RS = path.resolve(__dirname, '../../../programs/moon-forge/src/constants.rs');
const have = fs.existsSync(RS);
const src = have ? fs.readFileSync(RS, 'utf8') : '';

function rustConst(name: string): string {
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(new RegExp(`^pub const ${name}: [^=]+= (.+);`));
        if (!m) continue;
        const prev = lines.slice(Math.max(0, i - 3), i).filter((l) => !/^\s*\/\/\//.test(l)).pop() ?? '';
        if (/cfg\(feature = "localnet"\)/.test(prev)) continue;
        return m[1].replace(/\/\/.*$/, '').trim();
    }
    throw new Error(`${name} not found in constants.rs`);
}
const ENV: Record<string, string> = { XNT: '1000000000n', DAY: '86400n', BPS: '10000n' };
function val(name: string): bigint {
    let e = rustConst(name).replace(/ as u(8|16|32|64|128)/g, '').replace(/(\d)_(?=\d)/g, '$1').replace(/\b(\d+)\b/g, '$1n');
    for (const [k, v] of Object.entries(ENV)) e = e.replace(new RegExp(`\\b${k}\\b`, 'g'), `(${v})`);
    e = e.replace(/\b([A-Z][A-Z0-9_]+)\b/g, (_m, n) => `(${val(n)}n)`);
    return Function(`"use strict"; return (${e});`)() as bigint;
}
const num = (n: string) => Number(val(n));

describe.skipIf(!have)('rules-3 game constants mirror constants.rs', () => {
    it('house bets', () => {
        expect(val('MIN_STAKE')).toBe(G.MIN_STAKE);
        expect([num('COINFLIP_CHANCE_BPS'), num('MIN_CHANCE_BPS'), num('MAX_CHANCE_BPS'), num('MIN_TARGET_BPS'), num('MAX_TARGET_BPS')])
            .toEqual([G.COINFLIP_CHANCE_BPS, G.MIN_CHANCE_BPS, G.MAX_CHANCE_BPS, G.MIN_TARGET_BPS, G.MAX_TARGET_BPS]);
        expect(num('RTP_NUMERATOR')).toBe(G.RTP_NUMERATOR);
        expect([num('BET_KEEPER'), num('BET_ANCHORED'), num('BET_GAME_MASK')]).toEqual([G.BET_KEEPER, G.BET_ANCHORED, G.BET_GAME_MASK]);
        expect(val('BET_SLOT_BITS')).toBe(G.BET_SLOT_BITS);
    });
    it('the keeper seat, its dated opening and the Jackpot limits', () => {
        expect([num('KEEPER_NOTICE'), num('KEEPER_DEAD_DELAY'), num('KEEPER_STALL_SLOTS'), num('KEEPER_MAX_CHAIN')])
            .toEqual([G.KEEPER_NOTICE, G.KEEPER_DEAD_DELAY, G.KEEPER_STALL_SLOTS, G.KEEPER_MAX_CHAIN]);
        expect(num('KEEPER_OPEN_TS')).toBe(G.KEEPER_OPEN_TS);
        expect(new Date(G.KEEPER_OPEN_TS * 1000).toISOString()).toBe('2026-12-16T00:00:00.000Z');
        expect([num('JACKPOT_MAX_BACKLOG'), num('JACKPOT_DURATION')]).toEqual([G.JACKPOT_MAX_BACKLOG, G.JACKPOT_DURATION]);
    });
    it('sealed Duel and Moon Wars clocks', () => {
        expect(val('DUEL_MIN_STAKE')).toBe(G.DUEL_MIN_STAKE);
        expect([num('P2P_OFFER_TTL'), num('DUEL_JOIN_REVEAL_WINDOW'), num('DUEL_REVEAL_WINDOW')]).toEqual([G.P2P_OFFER_TTL, G.DUEL_JOIN_REVEAL_WINDOW, G.DUEL_REVEAL_WINDOW]);
        expect(val('WAR_MIN_STAKE')).toBe(G.WAR_MIN_STAKE);
        expect([num('WAR_SEED_WINDOW'), num('WAR_REVEAL_WINDOW'), num('WAR_FIRST_TURN_GRACE'), num('WAR_TURN_FREE'), num('WAR_TIME_BANK'), num('WAR_TURN_TIMEOUT'), num('WAR_MAX_ROUNDS')])
            .toEqual([G.WAR_SEED_WINDOW, G.WAR_REVEAL_WINDOW, G.WAR_FIRST_TURN_GRACE, G.WAR_TURN_FREE, G.WAR_TIME_BANK, G.WAR_TURN_TIMEOUT, G.WAR_MAX_ROUNDS]);
        expect(val('WAR_V2')).toBe(G.WAR_V2);
        // the facts the task names: offer 24 h, joiner opens in 10 min, creator ~1 h; seed 600 s, reveal 120 s, 30 s + 300 s bank, 120 s a turn
        expect([G.P2P_OFFER_TTL, G.DUEL_JOIN_REVEAL_WINDOW, G.DUEL_REVEAL_WINDOW]).toEqual([86_400, 600, 3_602]);
        expect([G.WAR_SEED_WINDOW, G.WAR_REVEAL_WINDOW, G.WAR_TURN_FREE, G.WAR_TIME_BANK, G.WAR_TURN_TIMEOUT]).toEqual([600, 120, 30, 300, 120]);
    });
});
