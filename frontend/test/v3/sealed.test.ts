/**
 * Sealed Duel / Moon Wars encoding (src/v3/sealed.ts) against the program's own vectors (Appendix A: p2p.rs
 * join_commitment_matches_the_clients, wars.rs vectors_match_the_clients) and, when the agent kit's dependencies are
 * installed in this checkout, against the kit (agents/kit/rules-v3.mjs) on fixed inputs; the phase rules (who acts, until
 * when, what happens if the other player stops); and the browser secrets store with its explicit backup.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import {
    duelCommitment, duelJoinCommitment, duelPhase, duelWinner, firstMover, IF_STOPS, isSealedWar, SecretsStore, toHex, warClockBanks,
    warEntropyCommitment, warJoinCommitment, warPhase, warSeedV2, warShuffle, type StorageLike,
} from '../../src/v3/sealed';
import { DUEL_JOIN_REVEAL_WINDOW, DUEL_REVEAL_WINDOW, WAR_REVEAL_WINDOW, WAR_SEED_WINDOW, WAR_V2 } from '../../src/v3/games-constants';

const fill = (b: number) => new Uint8Array(32).fill(b);
const key = (b: number) => new PublicKey(fill(b));
const hx = (u: Uint8Array) => toHex(u);

describe('commitments: the program vectors (Appendix A)', () => {
    it('duel join, war entropy, war join (with and without a move key), war seed, first mover, shuffles', () => {
        expect(hx(duelJoinCommitment(1, fill(9), key(1), key(2)))).toBe('4174fb36832c31540985c74b2a24465def836269b4b4de407a978fbc546baf16');
        expect(hx(duelJoinCommitment(1, fill(9), key(1), key(3)))).not.toBe('4174fb36832c31540985c74b2a24465def836269b4b4de407a978fbc546baf16');
        const war = key(3);
        expect(hx(warEntropyCommitment(fill(0x11), war))).toBe('e378a43ae0a14034a945d26c989404d4fdeef6bc9f55a88dc5ac25b4d6b5c47e');
        expect(hx(warJoinCommitment(fill(0x22), war, key(2), key(5)))).toBe('9b626ddbfe0a5a98d56d34f1bd17e240cda294693fc47bd3a4f211a60597c4ca');
        expect(hx(warJoinCommitment(fill(0x22), war, key(2), PublicKey.default))).toBe('30a7c218735b2adf3d68246cc4bf597f1e6f0761e1b05de96d86eb27403efa7d');
        const seed = warSeedV2(fill(0x11), fill(0x22), war);
        expect(hx(seed)).toBe('68a32bd6dbee1110f0c0483b611d5aaebe22f342361234bd08f2898b58f890f7');
        expect(firstMover(seed)).toBe(1);
        expect(warShuffle(seed, 0)).toEqual([2, 2, 1, 0, 1, 3, 1, 0, 0, 0]);
        expect(warShuffle(seed, 1)).toEqual([0, 1, 0, 0, 1, 3, 2, 0, 2, 1]);
    });
    it('the creator duel commitment (kit vector), hex and byte inputs agree, bad inputs refused', () => {
        expect(hx(duelCommitment(2, fill(4), key(5)))).toBe('84253c4a00dab5bf63ace927c2299a1cf38bfb818cf1aa07c9b768af1147da78');
        expect(hx(duelCommitment(2, '04'.repeat(32), key(5).toBase58()))).toBe(hx(duelCommitment(2, fill(4), key(5))));
        expect(() => duelCommitment(4, fill(4), key(5))).toThrow(/element/);
        expect(() => duelCommitment(0, '04', key(5))).toThrow(/32 bytes/);
    });
    it('duel outcome cycle and the clock word', () => {
        expect(duelWinner(0, 1)).toBe('opponent');
        expect(duelWinner(3, 2)).toBe('creator');
        expect(duelWinner(0, 2)).toBe('draw');
        expect(duelWinner(1, 1)).toBe('draw');
        expect(isSealedWar(WAR_V2 | (300n << 16n) | 300n)).toBe(true);
        expect(isSealedWar(123_456n)).toBe(false);
        expect(warClockBanks(0x8000_0000_012c_012cn)).toEqual([300, 300]);
        expect(warClockBanks(WAR_V2 | (17n << 16n) | 250n)).toEqual([17, 250]);
    });
});

const KIT = path.resolve(__dirname, '../../../agents/kit');
const kitReady = fs.existsSync(path.join(KIT, 'rules-v3.mjs')) && fs.existsSync(path.join(KIT, 'node_modules', '@noble', 'hashes'));
describe.skipIf(!kitReady)('commitments: the same bytes as the agent kit on fixed inputs', () => {
    it('every sealed-game function', async () => {
        const kit: any = await import(/* @vite-ignore */ pathToFileURL(path.join(KIT, 'rules-v3.mjs')).href);
        for (let i = 1; i <= 12; i++) {
            const salt = fill((i * 37) & 0xff); const duel = key(i); const opp = key(i + 100); const mk = key(i + 200);
            const el = i % 4;
            expect(hx(duelCommitment(el, salt, duel))).toBe(kit.duelCommitment(el, Buffer.from(salt), duel).toString('hex'));
            expect(hx(duelJoinCommitment(el, salt, duel, opp))).toBe(kit.duelJoinCommitment(el, Buffer.from(salt), duel, opp).toString('hex'));
            expect(hx(warEntropyCommitment(salt, duel))).toBe(kit.warEntropyCommitment(Buffer.from(salt), duel).toString('hex'));
            expect(hx(warJoinCommitment(salt, duel, opp, mk))).toBe(kit.warJoinCommitment(Buffer.from(salt), duel, opp, mk).toString('hex'));
            const seed = warSeedV2(salt, fill(i), duel);
            expect(hx(seed)).toBe(kit.warSeedV2(Buffer.from(salt), Buffer.from(fill(i)), duel).toString('hex'));
            expect(firstMover(seed)).toBe(kit.firstMover(Buffer.from(seed)));
            for (const d of [[0, 1], [3, 2], [2, 0], [1, 1]]) {
                const k = kit.duelWinner(d[0], d[1]);
                expect(duelWinner(d[0], d[1])).toBe(k === null ? 'draw' : k ? 'opponent' : 'creator');
            }
        }
    });
});

describe('phases: who acts, until when, and what happens if the other player stops', () => {
    const creator = key(1); const joiner = key(2); const stranger = key(3);
    const duel = (state: number, opponentElement: number, deadline: number) => ({ creator, opponent: state ? joiner : PublicKey.default, state, opponentElement, deadline });
    it('duel: offer, sealed join (joiner opens in 10 min, else its stake to the pool), opened (creator reveals in ~1 h, else the joiner wins)', () => {
        expect(duelPhase(duel(0, 0, 1_000), creator, 500).action).toBe('cancel');
        expect(duelPhase(duel(0, 0, 1_000), stranger, 500).action).toBeNull();
        expect(duelPhase(duel(0, 0, 1_000), creator, 1_001).step).toBe('expired-offer');
        expect(duelPhase(duel(0, 0, 0), creator, 9e9).step).toBe('open'); // an offer from before the upgrade never expires
        const sealed = duel(1, 255, 2_000 + DUEL_JOIN_REVEAL_WINDOW);
        expect(duelPhase(sealed, joiner, 2_100)).toMatchObject({ step: 'sealed', action: 'open' });
        expect(duelPhase(sealed, creator, 2_100).action).toBeNull();
        expect(duelPhase(sealed, stranger, 2_000 + DUEL_JOIN_REVEAL_WINDOW + 1).action).toBe('timeout');
        expect(duelPhase(sealed, stranger, 2_001).text).toContain("the joiner's stake goes to the burners' reward pool");
        const opened = duel(1, 2, 3_000 + DUEL_REVEAL_WINDOW);
        expect(duelPhase(opened, creator, 3_100)).toMatchObject({ step: 'opened', action: 'reveal' });
        expect(duelPhase(opened, joiner, 3_100).action).toBeNull();
        expect(duelPhase(opened, joiner, 3_000 + DUEL_REVEAL_WINDOW + 1).action).toBe('timeout');
        expect(duelPhase(opened, joiner, 3_100).text).toContain('the joiner receives the pot minus 2%');
    });
    it('war: seed (else a draw), reveal (else the creator wins), clock (out of time loses), payout; legacy matches are left alone', () => {
        const w = (state: number, turn: number, deadline: number, target = WAR_V2) => ({ creator, opponent: joiner, state, turn, deadline, targetSlot: target });
        expect(warPhase(w(0, 0, 100), creator, 50).step).toBe('open');
        const seed = w(1, 0, 1_000 + WAR_SEED_WINDOW);
        expect(warPhase(seed, creator, 1_100)).toMatchObject({ step: 'seed', awaited: 0, myStep: true, timeout: false });
        expect(warPhase(seed, joiner, 1_100).myStep).toBe(false);
        expect(warPhase(seed, stranger, 1_000 + WAR_SEED_WINDOW + 1)).toMatchObject({ timeout: true, myStep: false });
        expect(warPhase(seed, stranger, 1_000 + WAR_SEED_WINDOW + 1).text).toContain('draw');
        const reveal = w(1, 1, 2_000 + WAR_REVEAL_WINDOW);
        expect(warPhase(reveal, joiner, 2_050)).toMatchObject({ step: 'reveal', awaited: 1, myStep: true });
        expect(warPhase(reveal, stranger, 2_000 + WAR_REVEAL_WINDOW + 1).text).toContain('creator the win');
        const active = w(2, 1, 5_000, WAR_V2 | (300n << 16n) | 300n);
        expect(warPhase(active, joiner, 4_999)).toMatchObject({ step: 'active', myStep: true });
        expect(warPhase(active, creator, 4_999).myStep).toBe(false);
        expect(warPhase(active, creator, 5_001).timeout).toBe(true);
        expect(warPhase(w(3, 0, 0), stranger, 1).step).toBe('done');
        expect(warPhase(w(1, 0, 10, 0n), creator, 1).step).toBe('legacy');
    });
    it('the stop texts are derived from the program constants', () => {
        expect(IF_STOPS.duelJoiner).toContain('10 minutes');
        expect(IF_STOPS.duelCreator).toContain('about 1 hour');
        expect(IF_STOPS.duelOffer).toContain('about 24 hours');
        expect(IF_STOPS.warSeed).toContain('10 minutes');
        expect(IF_STOPS.warReveal).toContain('2 minutes');
        expect(IF_STOPS.warClock).toContain('30 free seconds');
        expect(IF_STOPS.warClock).toContain('300-second bank');
        expect(IF_STOPS.warClock).toContain('120 seconds');
    });
});

class Mem implements StorageLike {
    m = new Map<string, string>();
    full = false;
    getItem(k: string) { return this.m.get(k) ?? null; }
    setItem(k: string, v: string) { if (this.full) throw new Error('QuotaExceeded'); this.m.set(k, v); }
    removeItem(k: string) { this.m.delete(k); }
    key(i: number) { return [...this.m.keys()][i] ?? null; }
    get length() { return this.m.size; }
}

describe('the browser secrets store and its backup', () => {
    const PROGRAM = '57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9';
    const acct = key(9).toBase58();
    it('writes before use, reuses the same bytes on a retry, refuses when the browser cannot keep it', () => {
        const mem = new Mem();
        const s = new SecretsStore(mem);
        let made = 0;
        const a = s.getOrCreate('duel-create', acct, () => { made++; return { element: 2, salt: '11'.repeat(32) }; });
        expect(a.reused).toBe(false);
        expect(mem.length).toBe(1);
        const b = s.getOrCreate('duel-create', acct, () => { made++; return { element: 3, salt: '22'.repeat(32) }; });
        expect(b.reused).toBe(true);
        expect(b.record.element).toBe(2);
        expect(made).toBe(1);
        s.annotate('duel-create', acct, { tx: 'abc', salt: '33'.repeat(32) }); // secret bytes never change
        expect(s.get('duel-create', acct)?.salt).toBe('11'.repeat(32));
        const full = new Mem(); full.full = true;
        expect(() => new SecretsStore(full).getOrCreate('duel-join', acct, () => ({ element: 1, salt: '11'.repeat(32) }))).toThrow(/did not keep/);
        expect(() => new SecretsStore(null).getOrCreate('duel-join', acct, () => ({ element: 1, salt: '11'.repeat(32) }))).toThrow(/cannot store/);
        expect(() => s.getOrCreate('duel-join', acct, () => ({ element: 7, salt: '11'.repeat(32) }))).toThrow(/malformed/);
    });
    it('export → import on another browser; never overwrites a different secret; refuses another program and malformed records', () => {
        const a = new SecretsStore(new Mem());
        a.getOrCreate('war-create', acct, () => ({ entropy: 'ab'.repeat(32), moveKey: key(5).toBase58() }));
        a.getOrCreate('war-key', acct, () => ({ publicKey: key(5).toBase58(), secretKey: 'cd'.repeat(64) }));
        a.getOrCreate('duel-join', key(8).toBase58(), () => ({ element: 0, salt: 'ef'.repeat(32) }));
        const text = a.exportSecrets(PROGRAM, new Date('2026-12-01T00:00:00Z'));
        const doc = JSON.parse(text);
        expect(doc.format).toBe('moonforge-sealed-secrets');
        expect(doc.records).toHaveLength(3);
        const b = new SecretsStore(new Mem());
        b.getOrCreate('duel-join', key(8).toBase58(), () => ({ element: 3, salt: '00'.repeat(32) }));
        const r = b.importSecrets(text, PROGRAM);
        expect(r).toMatchObject({ added: 2, same: 0, refused: 0 });
        expect(r.conflicts).toEqual([`duel-join ${key(8).toBase58()}`]);
        expect(b.get('duel-join', key(8).toBase58())?.element).toBe(3);
        expect(b.get('war-create', acct)?.entropy).toBe('ab'.repeat(32));
        expect(b.importSecrets(text, PROGRAM)).toMatchObject({ added: 0, same: 2 });
        expect(() => b.importSecrets(text, '11111111111111111111111111111111')).toThrow(/another program/);
        expect(() => b.importSecrets('{"format":"x"}', PROGRAM)).toThrow(/not a Moon Forge secrets backup/);
        const bad = JSON.stringify({ ...doc, records: [{ kind: 'duel-join', account: acct, createdAt: 'x', element: 9, salt: 'zz' }] });
        expect(b.importSecrets(bad, PROGRAM).refused).toBe(1);
    });
});
