/**
 * The rules-3 game builders (src/v3/games.ts) against the NEW IDL, offline (no RPC is ever called): every account the site
 * passes exists in the instruction, the order and writability are the IDL's, the data starts with the instruction's
 * discriminator and carries the sealed commitment byte for byte. Also the house odds and the stake cap (games.rs).
 */
import { describe, expect, it } from 'vitest';
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SYSVAR_SLOT_HASHES_PUBKEY } from '@solana/web3.js';
import fs from 'node:fs';
import path from 'node:path';
import { parseV3Idl } from '../../src/v3/program';
import { V3_PDA } from '../../src/v3/extra';
import {
    buildAnchorBet, buildCancelDuel, buildCancelWar, buildClaimDuelTimeout, buildClaimWarTimeout, buildCreateDuel, buildCreateWarSealed, buildJoinDuelSealed,
    buildJoinWarSealed, buildOpenPlayer, buildPlaceBetV2, buildRefundStalledBet, buildRevealDuel, buildRevealDuelJoin, buildRevealWar, buildSeedWar, buildSettleWar,
    buildWarMove, GAME_PDA, houseIsWin, houseOdds, maxStakeV3,
} from '../../src/v3/games';
import { duelCommitment, duelJoinCommitment, warEntropyCommitment, warJoinCommitment } from '../../src/v3/sealed';

const text = fs.readFileSync(path.resolve(__dirname, '../../src/idl/moon_forge.v3.json'), 'utf8');
const offline = new Connection('http://127.0.0.1:1', 'confirmed');
async function program() {
    const { idl } = await parseV3Idl(text);
    const w = { publicKey: Keypair.generate().publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t };
    return new anchor.Program(idl, new anchor.AnchorProvider(offline, w as any, {}));
}
const ixIdl = (name: string) => (JSON.parse(text).instructions as any[]).find((i) => i.name === name);
const flat = (accs: any[]): any[] => accs.flatMap((a) => (a.accounts ? flat(a.accounts) : [a]));
function checkLayout(name: string, ix: anchor.web3.TransactionInstruction) {
    const spec = flat(ixIdl(name).accounts);
    expect(ix.keys.length, `${name} account count`).toBe(spec.length);
    spec.forEach((a: any, i: number) => {
        expect(ix.keys[i].isWritable, `${name}.${a.name} writable`).toBe(!!a.writable);
        if (a.address) expect(ix.keys[i].pubkey.toBase58(), `${name}.${a.name} address`).toBe(a.address);
    });
    expect(Buffer.from(ix.data.subarray(0, 8)).toString('hex')).toBe(Buffer.from(ixIdl(name).discriminator).toString('hex'));
    return spec;
}
const at = (name: string, ix: anchor.web3.TransactionInstruction, acct: string) => ix.keys[flat(ixIdl(name).accounts).findIndex((a: any) => a.name === acct)].pubkey;
const salt = '5a'.repeat(32);

describe('sealed Duel builders', () => {
    it('create (no Artifact: system program in the ticket slots), join sealed, open, reveal, timeout, cancel', async () => {
        const p = await program();
        const owner = Keypair.generate().publicKey; const opp = Keypair.generate().publicKey; const architect = Keypair.generate().publicKey;
        const { duel, builder } = buildCreateDuel(p, { owner, nonce: 7n, stake: 100_000_000n, commitment: duelCommitment(2, salt, GAME_PDA.duel(owner, 7n)) });
        expect(duel.equals(GAME_PDA.duel(owner, 7n))).toBe(true);
        const c = await builder.instruction();
        checkLayout('create_duel', c);
        expect(at('create_duel', c, 'creator_state').equals(GAME_PDA.player(owner))).toBe(true);
        for (const t of ['asset', 'record', 'collection']) expect(at('create_duel', c, t).toBase58()).toBe('11111111111111111111111111111111');
        expect(Buffer.from(c.data.subarray(16, 48)).toString('hex')).toBe(Buffer.from(duelCommitment(2, salt, duel)).toString('hex'));
        const j = await buildJoinDuelSealed(p, { duel, opponent: opp, commitment: duelJoinCommitment(1, salt, duel, opp) }).instruction();
        checkLayout('join_duel_sealed', j);
        expect(Buffer.from(j.data.subarray(8, 40)).toString('hex')).toBe(Buffer.from(duelJoinCommitment(1, salt, duel, opp)).toString('hex'));
        const o = await buildRevealDuelJoin(p, { duel, opponent: opp, element: 1, salt }).instruction();
        checkLayout('reveal_duel_join', o);
        expect([o.data[8], Buffer.from(o.data.subarray(9, 41)).toString('hex')]).toEqual([1, salt]);
        const d = { creator: owner, opponent: opp, rentPayer: owner };
        const r = await buildRevealDuel(p, { duel, d, architect, element: 2, salt }).instruction();
        checkLayout('reveal_duel', r);
        expect(at('reveal_duel', r, 'architect').equals(architect)).toBe(true);
        expect(at('reveal_duel', r, 'opponent_state').equals(GAME_PDA.player(opp))).toBe(true);
        expect(at('reveal_duel', r, 'draw_vault').equals(V3_PDA.drawVault())).toBe(true);
        checkLayout('claim_duel_timeout', await buildClaimDuelTimeout(p, { duel, d, architect }).instruction());
        checkLayout('cancel_duel', await buildCancelDuel(p, { duel, creator: owner }).instruction());
    });
});

describe('sealed Moon Wars builders', () => {
    it('create with the move key and entropy commitment, join sealed, seed, reveal, moves, timeout, settle, cancel', async () => {
        const p = await program();
        const owner = Keypair.generate().publicKey; const opp = Keypair.generate().publicKey; const mk = Keypair.generate().publicKey;
        const { war, builder } = buildCreateWarSealed(p, { owner, nonce: 3n, stake: 250_000_000n, moveKey: mk, commitment: warEntropyCommitment(salt, GAME_PDA.war(owner, 3n)) });
        const c = await builder.instruction();
        checkLayout('create_war_sealed', c);
        expect(new PublicKey(c.data.subarray(16, 48)).equals(mk)).toBe(true);
        expect(Buffer.from(c.data.subarray(48, 80)).toString('hex')).toBe(Buffer.from(warEntropyCommitment(salt, war)).toString('hex'));
        const j = await buildJoinWarSealed(p, { war, opponent: opp, commitment: warJoinCommitment(salt, war, opp, mk) }).instruction();
        checkLayout('join_war_sealed', j);
        checkLayout('seed_war', await buildSeedWar(p, { war, signer: mk, entropy: salt }).instruction());
        const rv = await buildRevealWar(p, { war, signer: mk, secret: salt, moveKey: mk }).instruction();
        checkLayout('reveal_war', rv);
        expect(new PublicKey(rv.data.subarray(40, 72)).equals(mk)).toBe(true);
        checkLayout('war_summon', await buildWarMove(p, { war, signer: mk, move: { kind: 'summon', hand: 2 } }).instruction());
        const atk = await buildWarMove(p, { war, signer: mk, move: { kind: 'attack', attacker: 1, target: 255 } }).instruction();
        checkLayout('war_attack', atk);
        expect([atk.data[8], atk.data[9]]).toEqual([1, 255]);
        checkLayout('war_end_turn', await buildWarMove(p, { war, signer: owner, move: { kind: 'end' } }).instruction());
        checkLayout('claim_war_timeout', await buildClaimWarTimeout(p, war).instruction());
        checkLayout('settle_war', await buildSettleWar(p, { war, w: { creator: owner, opponent: opp, rentPayer: owner }, architect: Keypair.generate().publicKey }).instruction());
        checkLayout('cancel_war', await buildCancelWar(p, { war, creator: owner }).instruction());
    });
});

describe('house bets on the keeper chain', () => {
    it('open_player, place_bet_v2 (keeper seat appended), anchor_bet (SlotHashes), refund_stalled_bet', async () => {
        const p = await program();
        const owner = Keypair.generate().publicKey;
        checkLayout('open_player', await buildOpenPlayer(p, owner).instruction());
        const { bet, builder } = buildPlaceBetV2(p, { owner, signer: owner, nonce: 4n, architect: Keypair.generate().publicKey, game: 1, param: 2_500, choice: 0, stake: 10_000_000n, seed: new Uint8Array(32).fill(3) });
        expect(bet.equals(GAME_PDA.bet(GAME_PDA.player(owner), 4n))).toBe(true);
        const ix = await builder.instruction();
        const spec = checkLayout('place_bet_v2', ix);
        expect(spec[spec.length - 1].name).toBe('keeper_seat');
        expect(ix.keys[spec.length - 1].pubkey.equals(V3_PDA.houseKeeper())).toBe(true);
        expect(at('place_bet_v2', ix, 'bankroll_vault').equals(GAME_PDA.bankrollVault())).toBe(true);
        const a = await buildAnchorBet(p, bet).instruction();
        checkLayout('anchor_bet', a);
        expect(a.keys[1].pubkey.equals(SYSVAR_SLOT_HASHES_PUBKEY)).toBe(true);
        checkLayout('refund_stalled_bet', await buildRefundStalledBet(p, { bet, playerState: GAME_PDA.player(owner), rentPayer: owner }).instruction());
    });
    it('odds as games.rs (98% paid back, floored) and the win rule', () => {
        expect(houseOdds(0, 0, 0)).toEqual([5_000, 19_600]);
        expect(houseOdds(0, 0, 2)).toBeNull();
        expect(houseOdds(1, 2_500, 1)).toEqual([2_500, 39_200]);
        expect(houseOdds(1, 99, 0)).toBeNull();
        expect(houseOdds(1, 9_501, 0)).toBeNull();
        expect(houseOdds(2, 20_000, 0)).toEqual([4_900, 20_000]);
        expect(houseOdds(2, 10_499, 0)).toBeNull();
        expect(houseOdds(2, 1_000_001, 0)).toBeNull();
        expect(houseIsWin(0, 0, 5_000, 4_999)).toBe(true);
        expect(houseIsWin(0, 1, 5_000, 4_999)).toBe(false);
        expect(houseIsWin(1, 1, 2_500, 7_500)).toBe(true);
        expect(houseIsWin(1, 1, 2_500, 7_499)).toBe(false);
        expect(houseIsWin(2, 0, 4_900, 4_899)).toBe(true);
    });
    it('the stake cap respects the 0.25% net-win cap, the 5% pending cap and the keeper bond', () => {
        const XNT = 1_000_000_000n;
        // 1,000 XNT free, nothing pending, a big bond: the 0.25% cap binds (net win 2.5 XNT at 1.96× → 2.6041 XNT)
        expect(maxStakeV3(19_600, 1_000n * XNT, 0n, 1_000n * XNT, 0n)).toBe(2_604_100_000n);
        // a 20 XNT bond with 19 XNT pending: payout ≤ 1 XNT → stake ≤ 0.5102 XNT
        expect(maxStakeV3(19_600, 1_000n * XNT, 19n * XNT, 20n * XNT, 0n)).toBe(510_200_000n);
        // the bond minus a drawing Jackpot pot
        expect(maxStakeV3(19_600, 1_000n * XNT, 0n, 20n * XNT, 20n * XNT)).toBe(0n);
        // pending already at 5% of the bankroll: nothing fits
        expect(maxStakeV3(19_600, 1_000n * XNT, 50n * XNT, 1_000n * XNT, 0n)).toBe(0n);
        expect(maxStakeV3(10_000, 1_000n * XNT, 0n, 1_000n * XNT, 0n)).toBe(0n);
        // a cap never exceeds what bet_limits accepts: check the three rules at the returned stake
        for (const [m, vault, reserved, bond] of [[19_600, 384n * XNT, 0n, 20n * XNT], [1_000_000, 500n * XNT, 3n * XNT, 50n * XNT], [39_200, 10n * XNT, 0n, 25n * XNT]] as const) {
            const s = maxStakeV3(m, vault, reserved, bond, 0n);
            const payout = (s * BigInt(m)) / 10_000n;
            const stakeIn = s - (s / 100n) - (s / 200n);
            expect(payout - s <= ((vault - reserved) * 25n) / 10_000n).toBe(true);
            expect(reserved + payout <= ((vault + stakeIn) * 500n) / 10_000n).toBe(true);
            expect(bond >= reserved + payout).toBe(true);
        }
    });
});
