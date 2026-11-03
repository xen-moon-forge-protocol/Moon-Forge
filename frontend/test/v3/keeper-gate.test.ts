/**
 * The house-keeper gate (src/v3/keeper.ts): house games and the Jackpot are offered only while the CHAIN shows a live
 * keeper (seat armed, bond ≥ 20 XNT, no withdrawal announced, recent activity, backlog within the program's limit, and the
 * service levels kept on the bets pending now); never because of a constant. And how anyone can become the keeper:
 * the dated opening (2026-12-16 00:00 UTC) and the 28-day idle take-over.
 */
import { describe, expect, it } from 'vitest';
import * as anchor from '@coral-xyz/anchor';
import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
    betDiscriminator, houseNoBetsNoticeShown, jackpotOffered, KEEPER_ANCHOR_SLA_SLOTS, KEEPER_RECENT_S, KEEPER_REVEAL_SLA_SLOTS, keeperBetWait, keeperLiveness, lastKeeperActivity,
    keeperOpening, keeperSeatReady, newHouseBetsOffered,
} from '../../src/v3/keeper';
import * as K from '../../src/v3/keeper';
import { decodeHouseKeeper, type HouseKeeperView } from '../../src/v3/layout';
import { KEEPER_BOND_MIN } from '../../src/v3/constants';
import { BET_ANCHORED, BET_KEEPER, JACKPOT_MAX_BACKLOG, KEEPER_DEAD_DELAY, KEEPER_OPEN_TS, KEEPER_STALL_SLOTS } from '../../src/v3/games-constants';

const text = fs.readFileSync(path.resolve(__dirname, '../../src/idl/moon_forge.v3.json'), 'utf8');
const coder = new anchor.BorshAccountsCoder(JSON.parse(text));
const NOW = 1_800_000_000;
const SLOT = 10_000_000n;
async function seat(over: Partial<Record<string, any>> = {}): Promise<HouseKeeperView> {
    const v = {
        keeper: Keypair.generate().publicKey, pending_keeper: PublicKey.default, pending_ts: new anchor.BN(0), tip: new Array(32).fill(7), length: new anchor.BN(1000),
        next_index: new anchor.BN(10), revealed: new anchor.BN(10), bond: new anchor.BN((KEEPER_BOND_MIN * 2n).toString()), pending_bets: 0, last_active_ts: new anchor.BN(NOW - 3_600),
        armed_slot: new anchor.BN(1), week_start_ts: new anchor.BN(0), week_start_bankroll: new anchor.BN(0), week_net_loss: new anchor.BN(0), penalties: new anchor.BN(0),
        jackpot_reserved: new anchor.BN(0), withdraw_ts: new anchor.BN(0), bump: 255, ...over,
    };
    return decodeHouseKeeper(new Uint8Array(await coder.encode('HouseKeeper', v)))!;
}
const bet = (index: bigint, anchorSlot: bigint, anchored: boolean, keeper = true) => ({ game: (keeper ? BET_KEEPER : 0) | (anchored ? BET_ANCHORED : 0) | 1, targetSlot: (index << 40n) | anchorSlot });
const failed = (l: ReturnType<typeof keeperLiveness>) => l.failed.map((c) => c.id);

describe('the gate reads chain facts, never a constant', () => {
    it('no KEEPER_SLA_MET-style switch exists any more', () => {
        expect((K as any).KEEPER_SLA_MET).toBeUndefined();
        const src = fs.readFileSync(path.resolve(__dirname, '../../src/v3/keeper.ts'), 'utf8');
        expect(src).not.toMatch(/SLA_MET\s*=/);
    });
    it('a healthy seat with nothing pending is live; null, a default key or a failed read are not', async () => {
        const s = await seat();
        const l = keeperLiveness(s, [], SLOT, NOW);
        expect(l.live).toBe(true);
        expect(newHouseBetsOffered(l)).toBe(true);
        expect(jackpotOffered(l)).toBe(true);
        expect(houseNoBetsNoticeShown(l)).toBe(false);
        expect(keeperLiveness(null, [], SLOT, NOW).live).toBe(false);
        expect(failed(keeperLiveness(null, [], SLOT, NOW))).toEqual(['seat']);
        expect(keeperLiveness(await seat({ keeper: PublicKey.default }), [], SLOT, NOW).live).toBe(false);
        expect(failed(keeperLiveness(s, null, SLOT, NOW))).toEqual(['read']);
        expect(newHouseBetsOffered(null)).toBe(false);
        expect(jackpotOffered(null)).toBe(false);
        expect(houseNoBetsNoticeShown(null)).toBe(true);
    });
    it('armed (positions left), bond ≥ 20 XNT, no withdrawal notice, not dead (28 days idle), backlog ≤ 32', async () => {
        expect(failed(keeperLiveness(await seat({ next_index: new anchor.BN(1000), revealed: new anchor.BN(1000) }), [], SLOT, NOW))).toEqual(['armed']);
        expect(failed(keeperLiveness(await seat({ bond: new anchor.BN((KEEPER_BOND_MIN - 1n).toString()) }), [], SLOT, NOW))).toEqual(['bond']);
        expect(keeperLiveness(await seat({ bond: new anchor.BN(KEEPER_BOND_MIN.toString()) }), [], SLOT, NOW).live).toBe(true);
        expect(failed(keeperLiveness(await seat({ withdraw_ts: new anchor.BN(NOW - 10) }), [], SLOT, NOW))).toEqual(['leaving']);
        // idle time alone hides nothing before the program's dead-seat delay (no chicken-and-egg: no bets, nothing to settle)
        expect(KEEPER_RECENT_S).toBe(KEEPER_DEAD_DELAY);
        for (const idleS of [8 * 86_400, 21 * 86_400, KEEPER_DEAD_DELAY - 1]) {
            expect(keeperLiveness(await seat({ last_active_ts: new anchor.BN(NOW - idleS) }), [], SLOT, NOW).live, `idle ${idleS} s`).toBe(true);
        }
        const dead = keeperLiveness(await seat({ last_active_ts: new anchor.BN(NOW - KEEPER_DEAD_DELAY) }), [], SLOT, NOW);
        expect(failed(dead)).toEqual(['recent']);
        expect(dead.failed[0].text).toMatch(/No keeper activity .* for 28 days: the seat is dead/);
        // the last activity is shown as information on a live seat
        const at = await seat({ last_active_ts: new anchor.BN(1_797_379_200) });
        expect(lastKeeperActivity(at)).toBe('2026-12-16 00:00 UTC');
        expect(keeperLiveness(at, [], SLOT, 1_797_379_200 + 86_400).checks.find((c) => c.id === 'recent')?.text).toContain('Last keeper activity (arm, reveal or settle): 2026-12-16 00:00 UTC');
        expect(lastKeeperActivity(null)).toBe('none recorded');
        const back = (n: number) => seat({ next_index: new anchor.BN(10 + n), revealed: new anchor.BN(10) });
        expect(keeperLiveness(await back(JACKPOT_MAX_BACKLOG), [], SLOT, NOW).live).toBe(true);
        expect(failed(keeperLiveness(await back(JACKPOT_MAX_BACKLOG + 1), [], SLOT, NOW))).toEqual(['backlog']);
        expect(keeperSeatReady(await seat())).toBe(true);
        expect(keeperSeatReady(null)).toBe(false);
    });
    it('service levels on the bets pending now: reveal within ~10 min, anchor within 150 slots, nothing stalled or skipped', async () => {
        // an old last activity (20 days) does not matter while the pending bets meet the service levels; a late bet hides at once
        const s = await seat({ next_index: new anchor.BN(14), revealed: new anchor.BN(10), last_active_ts: new anchor.BN(NOW - 20 * 86_400) });
        // waiting anchored bets within the reveal service level, an unanchored one within 150 slots, a legacy bet (ignored)
        const ok = [bet(10n, SLOT - BigInt(KEEPER_REVEAL_SLA_SLOTS), true), bet(11n, SLOT - 5n, true), bet(12n, SLOT - BigInt(KEEPER_ANCHOR_SLA_SLOTS), false), bet(0n, 1n, false, false)];
        expect(keeperLiveness(s, ok, SLOT, NOW).live).toBe(true);
        expect(failed(keeperLiveness(s, [bet(10n, SLOT - BigInt(KEEPER_REVEAL_SLA_SLOTS) - 1n, true)], SLOT, NOW))).toEqual(['reveal']);
        expect(failed(keeperLiveness(s, [bet(12n, SLOT - BigInt(KEEPER_ANCHOR_SLA_SLOTS) - 1n, false)], SLOT, NOW))).toEqual(['anchor']);
        // stalled (anchored, past KEEPER_STALL_SLOTS), skipped (index < revealed), or never anchored past SlotHashes
        expect(failed(keeperLiveness(s, [bet(10n, SLOT - BigInt(KEEPER_STALL_SLOTS) - 1n, true)], SLOT, NOW))).toEqual(['stalled']);
        expect(failed(keeperLiveness(s, [bet(9n, SLOT - 1n, true)], SLOT, NOW))).toEqual(['stalled']);
        expect(failed(keeperLiveness(s, [bet(12n, SLOT - 600n, false)], SLOT, NOW))).toEqual(['stalled']);
    });
    it('keeperBetWait decodes the bet packing (index << 40 | anchor slot, keeper and anchored bits)', () => {
        const w = keeperBetWait(bet(7n, 123n, true), 5n, 200n);
        expect(w).toMatchObject({ keeper: true, index: 7n, anchor: 123n, anchored: true, refundable: false, age: 77n });
        expect(keeperBetWait(bet(4n, 123n, true), 5n, 200n).refundable).toBe(true);
        expect(keeperBetWait(bet(7n, 123n, false, false), 0n, 9_999n).keeper).toBe(false);
    });
    it('the Bet discriminator comes from the bundled IDL', () => {
        expect(betDiscriminator(JSON.parse(text))).toHaveLength(8);
        expect(() => betDiscriminator({ accounts: [] })).toThrow(/Bet discriminator/);
    });
});

describe('how anyone can become the keeper', () => {
    it('no seat: only the initial key before 2026-12-16 00:00 UTC, anyone from then on (20 XNT bond)', () => {
        const before = keeperOpening(null, KEEPER_OPEN_TS - 1);
        expect(before.state).toBe('not-open-yet');
        expect(before.text).toContain('2026-12-16 00:00 UTC');
        expect(before.text).toContain('only the initial keeper key');
        expect(before.text).toContain('20 XNT');
        const after = keeperOpening(null, KEEPER_OPEN_TS);
        expect(after.state).toBe('open');
        expect(after.text).toContain('anyone may create it now');
    });
    it('a held seat: takeable by anyone after 28 days without arm, reveal or settle', async () => {
        const s = await seat({ last_active_ts: new anchor.BN(NOW) });
        const held = keeperOpening(s, NOW + 1);
        expect(held.state).toBe('held');
        expect(held.when).toBe(new Date((NOW + KEEPER_DEAD_DELAY) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
        expect(keeperOpening(s, NOW + KEEPER_DEAD_DELAY - 1).state).toBe('held');
        const take = keeperOpening(s, NOW + KEEPER_DEAD_DELAY);
        expect(take.state).toBe('takeable');
        expect(take.text).toContain('anyone may take the seat now');
    });
});
