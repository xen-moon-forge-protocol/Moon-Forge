/**
 * Localnet smoke (FEATURE-MATRIX gap 13): drives the SITE's own rules-3 builders (src/v3/games.ts, src/v3/sealed.ts,
 * src/v3/keeper.ts) against a local validator running the upgraded program, instead of only checking them offline.
 *
 * NOT part of the normal test run: the file name does not match vitest's default pattern, and every case is skipped
 * unless MF_LOCALNET_RPC is set. Run it while a validator holds the state the localnet suites leave behind (program
 * built with `--features localnet`, Config initialized, ExtraState created), for example in tests/run-local.sh right after
 * the agent kit's e2e step:
 *
 *   (cd frontend && MF_LOCALNET_RPC=http://127.0.0.1:8899 npm run test:localnet)
 *
 * What it does (localnet windows: duel open 4 s, creator reveal 2 s, war seed 6 s / reveal 4 s, keeper stall 40 slots):
 *   1. two fresh players (airdropped), game wallets opened and funded through the builders;
 *   2. a sealed duel to the end: create (secret in the browser-style store first), join sealed, open, reveal, paid out;
 *   3. a sealed duel whose joiner never opens: closed on time, the creator refunded;
 *   4. a sealed Moon Wars start with move keys: create + fund, join sealed, seed and reveal signed by the move keys, the
 *      match is ACTIVE with the first mover the seed says; then the mover lets its time run out, timeout, payout;
 *   5. donations: the reward pool accepts, the Burn Lottery vault is refused (LotteryRetired);
 *   6. the keeper gate read from the validator (keeperLiveness); with an armed seat, a house bet is placed and anchored,
 *      seen waiting by the gate, and refunded as a win once the keeper (not running here) stalls past 40 slots.
 */
import { describe, expect, it } from 'vitest';
import * as anchor from '@coral-xyz/anchor';
import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import { parseV3Idl } from '../../src/v3/program';
import { V3_PDA } from '../../src/v3/extra';
import { rulesFromAccount } from '../../src/v3/detect';
import {
    buildAnchorBet, buildClaimDuelTimeout, buildClaimWarTimeout, buildCreateDuel, buildCreateWarSealed, buildJoinDuelSealed, buildJoinWarSealed, buildOpenPlayer,
    buildPlaceBetV2, buildRefundStalledBet, buildRevealDuel, buildRevealDuelJoin, buildRevealWar, buildSeedWar, buildSettleWar, GAME_PDA,
} from '../../src/v3/games';
import { duelCommitment, duelJoinCommitment, firstMover, SecretsStore, warEntropyCommitment, warJoinCommitment, warSeedV2, type StorageLike } from '../../src/v3/sealed';
import { betDiscriminator, keeperBetWait, readKeeperLiveness } from '../../src/v3/keeper';

const RPC = process.env.MF_LOCALNET_RPC ?? '';
const text = fs.readFileSync(path.resolve(__dirname, '../../src/idl/moon_forge.v3.json'), 'utf8');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const XNT = BigInt(LAMPORTS_PER_SOL);

class Mem implements StorageLike {
    m = new Map<string, string>();
    getItem(k: string) { return this.m.get(k) ?? null; }
    setItem(k: string, v: string) { this.m.set(k, v); }
    removeItem(k: string) { this.m.delete(k); }
    key(i: number) { return [...this.m.keys()][i] ?? null; }
    get length() { return this.m.size; }
}

describe.skipIf(!RPC)('localnet smoke: the site builders against the upgraded program', () => {
    // the describe body is collected even when skipped: never construct with an empty URL
    const connection = new Connection(RPC || 'http://127.0.0.1:8899', 'confirmed');
    let idl: anchor.Idl;
    const programFor = (kp: Keypair) => new anchor.Program(idl, new anchor.AnchorProvider(connection, {
        publicKey: kp.publicKey,
        signTransaction: async <T,>(tx: T) => { (tx as any).partialSign(kp); return tx; },
        signAllTransactions: async <T,>(txs: T[]) => { txs.forEach((t) => (t as any).partialSign(kp)); return txs; },
    } as any, { commitment: 'confirmed' }));
    const acc = (p: anchor.Program) => p.account as any;
    const chainNow = async () => (await connection.getBlockTime(await connection.getSlot('confirmed'))) ?? Math.floor(Date.now() / 1000);
    const waitPast = async (ts: number) => { while ((await chainNow()) <= ts) await sleep(500); };
    async function funded() {
        const kp = Keypair.generate();
        await connection.confirmTransaction(await connection.requestAirdrop(kp.publicKey, 50 * LAMPORTS_PER_SOL), 'confirmed');
        return kp;
    }
    async function player(kp: Keypair, depositXnt: bigint) {
        const p = programFor(kp);
        await buildOpenPlayer(p, kp.publicKey).rpc();
        await p.methods.deposit(new anchor.BN((depositXnt * XNT).toString())).accountsPartial({ playerState: GAME_PDA.player(kp.publicKey), payer: kp.publicKey, systemProgram: SystemProgram.programId }).rpc();
        return p;
    }
    const balance = async (p: anchor.Program, owner: PublicKey) => BigInt((await acc(p).playerState.fetch(GAME_PDA.player(owner))).balance.toString());
    const nonce = async (p: anchor.Program, owner: PublicKey) => BigInt((await acc(p).playerState.fetch(GAME_PDA.player(owner))).nonce.toString());

    it('the validator runs the upgraded program (ExtraState exists and decodes: rules 3)', async () => {
        idl = (await parseV3Idl(text)).idl;
        const info = await connection.getAccountInfo(V3_PDA.extraState());
        expect(rulesFromAccount(info ? { owner: info.owner, data: new Uint8Array(info.data) } : null).rules).toBe(3);
    }, 60_000);

    it('a sealed duel to the end, and one whose joiner never opens', async () => {
        const [a, b] = await Promise.all([funded(), funded()]);
        const [pa, pb] = await Promise.all([player(a, 2n), player(b, 2n)]);
        const sa = new SecretsStore(new Mem()); const sb = new SecretsStore(new Mem());
        const stake = XNT / 10n;
        // 1. Solar (2) against Cosmic (1): the creator wins the pot minus 2%
        let n = await nonce(pa, a.publicKey);
        const duel = GAME_PDA.duel(a.publicKey, n);
        const ca = sa.getOrCreate('duel-create', duel.toBase58(), () => ({ element: 2, salt: '1'.repeat(64) })).record;
        await buildCreateDuel(pa, { owner: a.publicKey, nonce: n, stake, commitment: duelCommitment(ca.element as number, ca.salt as string, duel) }).builder.rpc();
        const cb = sb.getOrCreate('duel-join', duel.toBase58(), () => ({ element: 1, salt: '2'.repeat(64) })).record;
        await buildJoinDuelSealed(pb, { duel, opponent: b.publicKey, commitment: duelJoinCommitment(cb.element as number, cb.salt as string, duel, b.publicKey) }).rpc();
        await waitPast(await chainNow());
        await buildRevealDuelJoin(pb, { duel, opponent: b.publicKey, element: cb.element as number, salt: cb.salt as string }).rpc();
        const before = await balance(pa, a.publicKey);
        const d = await acc(pa).duel.fetch(duel);
        const architect = (await acc(pa).config.fetch(V3_PDA.config())).architect;
        await buildRevealDuel(pa, { duel, d, architect, element: ca.element as number, salt: ca.salt as string }).rpc();
        expect(await connection.getAccountInfo(duel)).toBeNull();
        expect(await balance(pa, a.publicKey) - before).toBe(stake * 2n - (stake * 2n * 200n) / 10_000n);
        // 2. the joiner never opens: after the 4-s window anyone closes it; the creator gets its stake back
        n = await nonce(pa, a.publicKey);
        const duel2 = GAME_PDA.duel(a.publicKey, n);
        const c2 = sa.getOrCreate('duel-create', duel2.toBase58(), () => ({ element: 0, salt: '3'.repeat(64) })).record;
        await buildCreateDuel(pa, { owner: a.publicKey, nonce: n, stake, commitment: duelCommitment(c2.element as number, c2.salt as string, duel2) }).builder.rpc();
        await buildJoinDuelSealed(pb, { duel: duel2, opponent: b.publicKey, commitment: duelJoinCommitment(3, '4'.repeat(64), duel2, b.publicKey) }).rpc();
        const d2 = await acc(pa).duel.fetch(duel2);
        await waitPast(Number(d2.deadline.toString()));
        const aBefore = await balance(pa, a.publicKey);
        await buildClaimDuelTimeout(pb, { duel: duel2, d: d2, architect }).rpc();
        expect(await balance(pa, a.publicKey) - aBefore).toBe(stake);
    }, 180_000);

    it('a sealed Moon Wars start signed by the move keys, then a timeout and the payout', async () => {
        const [a, b] = await Promise.all([funded(), funded()]);
        const [pa, pb] = await Promise.all([player(a, 2n), player(b, 2n)]);
        const [ka, kb] = [Keypair.generate(), Keypair.generate()];
        const stake = XNT / 10n;
        const n = await nonce(pa, a.publicKey);
        const war = GAME_PDA.war(a.publicKey, n);
        const entropy = '5'.repeat(64); const secret = '6'.repeat(64);
        const fund = (from: PublicKey, to: PublicKey) => SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: LAMPORTS_PER_SOL / 20 });
        await buildCreateWarSealed(pa, { owner: a.publicKey, nonce: n, stake, moveKey: ka.publicKey, commitment: warEntropyCommitment(entropy, war) }).builder.postInstructions([fund(a.publicKey, ka.publicKey)]).rpc();
        await buildJoinWarSealed(pb, { war, opponent: b.publicKey, commitment: warJoinCommitment(secret, war, b.publicKey, kb.publicKey) }).postInstructions([fund(b.publicKey, kb.publicKey)]).rpc();
        await buildSeedWar(programFor(ka), { war, signer: ka.publicKey, entropy }).rpc();
        await buildRevealWar(programFor(kb), { war, signer: kb.publicKey, secret, moveKey: kb.publicKey }).rpc();
        const w = await acc(pa).war.fetch(war);
        expect(w.state).toBe(2);
        expect(w.turn).toBe(firstMover(warSeedV2(entropy, secret, war)));
        // nobody moves: the mover's time runs out (the creator's first turn has its 10-s localnet grace), then anyone settles
        await waitPast(Number(w.deadline.toString()));
        await buildClaimWarTimeout(pb, war).rpc();
        const done = await acc(pa).war.fetch(war);
        expect(done.state).toBe(3);
        const architect = (await acc(pa).config.fetch(V3_PDA.config())).architect;
        await buildSettleWar(pa, { war, w: done, architect }).rpc();
        expect(await connection.getAccountInfo(war)).toBeNull();
    }, 180_000);

    it('donations: the reward pool accepts, the Burn Lottery vault is refused', async () => {
        const a = await funded();
        const p = programFor(a);
        await p.methods.donate(0, new anchor.BN(1_000_000)).accountsPartial({ config: V3_PDA.config(), donor: a.publicKey, vault: V3_PDA.rewardVault(), systemProgram: SystemProgram.programId }).rpc();
        await expect(p.methods.donate(2, new anchor.BN(1_000_000)).accountsPartial({ config: V3_PDA.config(), donor: a.publicKey, vault: V3_PDA.drawVault(), systemProgram: SystemProgram.programId }).rpc())
            .rejects.toThrow(/LotteryRetired|InvalidTarget/);
    }, 60_000);

    it('the keeper gate reads the validator; with an armed seat a bet is placed, anchored, seen waiting, then refunded as stalled', async () => {
        const bs58 = (b: Uint8Array) => anchor.utils.bytes.bs58.encode(b);
        const g = await readKeeperLiveness(connection, bs58, betDiscriminator(idl as any));
        expect(g.liveness.checks.length).toBeGreaterThan(0);
        if (!g.seat || g.seat.nextIndex >= g.seat.length) return; // no armed seat on this validator: the gate says why (checked above)
        const a = await funded();
        const p = await player(a, 2n);
        const architect = (await acc(p).config.fetch(V3_PDA.config())).architect;
        const { bet, builder } = buildPlaceBetV2(p, { owner: a.publicKey, signer: a.publicKey, nonce: await nonce(p, a.publicKey), architect, game: 0, param: 0, choice: 0, stake: XNT / 100n, seed: new Uint8Array(32).fill(9) });
        try { await builder.rpc(); } catch (e: any) {
            // the localnet suites may leave the bankroll or the bond too small for even 0.01 XNT: that refusal is the program's
            expect(String(e?.message ?? e)).toMatch(/BankrollTooSmall|KeeperBondTooSmall|DailyLossLimit|WeeklyLossLimit|KeeperNotArmed/);
            return;
        }
        for (let i = 0; i < 20; i++) { try { await buildAnchorBet(p, bet).rpc(); break; } catch { await sleep(400); } }
        const b = await acc(p).bet.fetch(bet);
        expect(b.game & 0xc0).toBe(0xc0);
        const seen = await readKeeperLiveness(connection, bs58, betDiscriminator(idl as any));
        const wait = keeperBetWait({ game: b.game, targetSlot: BigInt(b.targetSlot.toString()) }, seen.seat!.revealed, BigInt(await connection.getSlot('confirmed')));
        expect(wait.anchored).toBe(true);
        // no keeper reveals on this validator: past the 40-slot LOCALNET stall window (constants.rs, localnet
        // KEEPER_STALL_SLOTS = 40) the bet is paid as a win from the bond. keeperBetWait above uses the site's MAINNET
        // window (235,000 slots), so the wait here is on the localnet one, bounded.
        const LOCALNET_STALL_SLOTS = 40n;
        const anchorSlot = wait.anchor;
        const until = Date.now() + 120_000;
        while (BigInt(await connection.getSlot('confirmed')) <= anchorSlot + LOCALNET_STALL_SLOTS) {
            if (Date.now() > until) throw new Error(`the validator did not pass slot ${anchorSlot + LOCALNET_STALL_SLOTS} within 120 s`);
            await sleep(500);
        }
        const before = await balance(p, a.publicKey);
        // the refund is retried (bounded) while the program still sees the bet inside its window (slot clocks differ by a few)
        let refunded = false;
        for (let i = 0; i < 30 && !refunded; i++) {
            try {
                await buildRefundStalledBet(p, { bet, playerState: b.playerState, rentPayer: b.rentPayer }).rpc();
                refunded = true;
            } catch (e: any) {
                if (!(await connection.getAccountInfo(bet))) return; // the localnet keeper of the suites settled it first
                if (i === 29) throw e;
                await sleep(1_000);
            }
        }
        expect(await connection.getAccountInfo(bet)).toBeNull();
        expect(await balance(p, a.publicKey) - before).toBe(BigInt(b.payout.toString()));
    }, 300_000);
});

