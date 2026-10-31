/**
 * The rules-3 mirror (src/v3/constants.ts) against the program source it mirrors (programs/moon-forge/src/constants.rs,
 * mainnet values). The program is read from this checkout; when the program build is re-synced, this test says which
 * mirrored value moved.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import * as C from '../../src/v3/constants';
import { PROGRAM_PK } from '../../src/v3/detect';

const RS = path.resolve(__dirname, '../../../programs/moon-forge/src/constants.rs');
const have = fs.existsSync(RS);
const src = have ? fs.readFileSync(RS, 'utf8') : '';

/** Mainnet value of `pub const NAME` (a `#[cfg(feature = "localnet")]` definition is skipped). */
function rustConst(name: string): string {
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(new RegExp(`^pub const ${name}: [^=]+= (.+);`));
        if (!m) continue;
        if (/cfg\(feature = "localnet"\)/.test(lines[i - 1] ?? '') || /cfg\(feature = "localnet"\)/.test(lines[i - 2] ?? '') && /^\s*\/\/\//.test(lines[i - 1] ?? '')) continue;
        return m[1].replace(/\/\/.*$/, '').trim();
    }
    throw new Error(`${name} not found in constants.rs`);
}
const ENV: Record<string, string> = { XNT: '1000000000n', DAY: '86400n', BPS: '10000n', KEEPER_TIP: '2000000n' };
function evalRust(expr: string): bigint | bigint[] {
    let e = expr.replace(/ as u(8|16|32|64|128)/g, '').replace(/(\d)_(?=\d)/g, '$1').replace(/\b(\d+)\b/g, '$1n');
    for (const [k, v] of Object.entries(ENV)) e = e.replace(new RegExp(`\\b${k}\\b`, 'g'), `(${v})`);
    if (/[A-Za-z_]/.test(e.replace(/\d+n/g, ''))) {
        // a reference to another constant: resolve it once
        e = e.replace(/\b([A-Z][A-Z0-9_]+)\b/g, (_m, n) => `(${String(evalRust(rustConst(n)))}n)`);
    }
    return Function(`"use strict"; return (${e});`)() as bigint | bigint[];
}
const val = (n: string) => evalRust(rustConst(n));
const arr = (n: string) => (val(n) as bigint[]).map(BigInt);

describe.skipIf(!have)('rules-3 constants mirror programs/moon-forge/src/constants.rs', () => {
    it('forge split 50 / 20 / 25 / 0 / 5 and its percent form', () => {
        expect([val('FORGE_BACKING_BPS'), val('FORGE_POOL_BPS'), val('FORGE_EXTRA_BPS'), val('FORGE_DRAW_BPS'), val('FORGE_ARCHITECT_BPS')])
            .toEqual([C.FORGE_SPLIT_BPS.backing, C.FORGE_SPLIT_BPS.pool, C.FORGE_SPLIT_BPS.extra, C.FORGE_SPLIT_BPS.draw, C.FORGE_SPLIT_BPS.architect]);
        const p = C.FORGE_SPLIT_PCT;
        expect([p.floorPct, p.basePotPct, p.extraPotPct, p.lotteryPct, p.architectPct].map((x) => BigInt(x * 100)))
            .toEqual([C.FORGE_SPLIT_BPS.backing, C.FORGE_SPLIT_BPS.pool, C.FORGE_SPLIT_BPS.extra, C.FORGE_SPLIT_BPS.draw, C.FORGE_SPLIT_BPS.architect]);
    });
    it('PX arrays, limits and launch time', () => {
        expect(arr('ARTIFACT_PRICE')).toEqual([...C.ARTIFACT_PRICE]);
        expect(arr('ARTIFACT_SUPPLY').map(Number)).toEqual([...C.ARTIFACT_SUPPLY]);
        expect(arr('PRICE_UP_NUM')).toEqual([...C.PRICE_UP_NUM]);
        expect(arr('PRICE_UP_DEN')).toEqual([...C.PRICE_UP_DEN]);
        expect(arr('PRICE_DECAY_PERIOD').map(Number)).toEqual([...C.PRICE_DECAY_PERIOD]);
        expect(arr('MIN_PRICE_BPS')).toEqual([...C.MIN_PRICE_BPS]);
        expect(val('MAX_PRICE_MULTIPLE')).toBe(C.MAX_PRICE_MULTIPLE);
        expect(Number(val('PRICE_MAX_STEPS'))).toBe(C.PRICE_MAX_STEPS);
        expect(Number(val('PRICE_LAUNCH_TS'))).toBe(C.PRICE_LAUNCH_TS);
        expect(arr('ARTIFACT_WEEKLY_CHIPS').map(Number)).toEqual([...C.ARTIFACT_WEEKLY_CHIPS]);
    });
    it('claims, extra pot, market, games, Genesis deadline', () => {
        expect([val('KEEPER_TIP'), val('KEEPER_TIP_MIN_CLAIM')]).toEqual([C.KEEPER_TIP, C.KEEPER_TIP_MIN_CLAIM]);
        expect(Number(val('CLAIM_HOLD'))).toBe(C.CLAIM_HOLD_SECONDS);
        expect([val('EXTRA_RELEASE_BPS'), val('EXTRA_BACKING_BOUND_BPS'), val('EXTRA_MAX_LEAVES')]).toEqual([C.EXTRA_RELEASE_BPS, C.EXTRA_BACKING_BOUND_BPS, BigInt(C.EXTRA_MAX_LEAVES)]);
        expect(Number(val('EXTRA_MAX_WEEKS'))).toBe(C.EXTRA_MAX_WEEKS);
        expect(rustConst('LEAF_DOMAIN_EXTRA')).toBe(`b"${C.LEAF_DOMAIN_EXTRA}"`);
        expect([val('MARKET_ROYALTY_BPS'), val('MARKET_POOL_BPS'), val('MARKET_MIN_PRICE'), val('SECONDARY_ROYALTY_BPS')])
            .toEqual([C.MARKET_ROYALTY_BPS, C.MARKET_POOL_BPS, C.MARKET_MIN_PRICE, C.SECONDARY_ROYALTY_BPS]);
        expect(Number(val('MARKET_MAX_LISTING'))).toBe(C.MARKET_MAX_LISTING_SECONDS);
        expect([val('KEEPER_BOND_MIN'), val('JACKPOT_MAX_POT'), val('KEEPER_SETTLE_TIP')]).toEqual([C.KEEPER_BOND_MIN, C.JACKPOT_MAX_POT, C.KEEPER_SETTLE_TIP]);
        expect([val('HOUSE_EDGE_BPS'), val('EDGE_TO_POOL_BPS'), val('EDGE_TO_ARCHITECT_BPS'), val('P2P_RAKE_BPS'), val('RAKE_TO_POOL_BPS'), val('RAKE_TO_ARCHITECT_BPS')])
            .toEqual([C.HOUSE_EDGE_BPS, C.EDGE_TO_POOL_BPS, C.EDGE_TO_ARCHITECT_BPS, C.P2P_RAKE_BPS, C.RAKE_TO_POOL_BPS, C.RAKE_TO_ARCHITECT_BPS]);
        expect([val('MAX_EXPOSURE_BPS'), val('MAX_TOTAL_EXPOSURE_BPS'), val('MAX_DAILY_LOSS_BPS'), val('MAX_WEEKLY_LOSS_BPS')])
            .toEqual([C.MAX_EXPOSURE_BPS, C.MAX_TOTAL_EXPOSURE_BPS, C.MAX_DAILY_LOSS_BPS, C.MAX_WEEKLY_LOSS_BPS]);
        expect([Number(val('HOUSE_WITHDRAW_DELAY')), Number(val('HOUSE_WITHDRAW_WINDOW'))]).toEqual([C.HOUSE_WITHDRAW_DELAY_SECONDS, C.HOUSE_WITHDRAW_WINDOW_SECONDS]);
        expect(Number(val('AIRDROP_DEADLINE'))).toBe(C.AIRDROP_DEADLINE);
    });
    it('the new PDAs are the ones the program comments name', () => {
        const p = (seed: string) => PublicKey.findProgramAddressSync([new TextEncoder().encode(seed)], PROGRAM_PK)[0].toBase58();
        expect(p('extra_state')).toBe(C.V3_PDAS.extraState);
        expect(p('extra_vault')).toBe(C.V3_PDAS.extraVault);
        expect(p('house_keeper')).toBe(C.V3_PDAS.houseKeeper);
        expect(p('oracle_seat')).toBe(C.V3_PDAS.oracleSeat);
        for (const [seed, addr] of [['extra_state', C.V3_PDAS.extraState], ['extra_vault', C.V3_PDAS.extraVault], ['house_keeper', C.V3_PDAS.houseKeeper], ['oracle_seat', C.V3_PDAS.oracleSeat]]) {
            expect(src).toContain(`b"${seed}"; // PDA ${addr}`);
        }
    });
});
