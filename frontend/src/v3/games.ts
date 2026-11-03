/**
 * Rules-3 games: transaction builders and wallet actions for the sealed Artifact Duel, sealed Moon Wars and house bets on
 * the keeper's hash chain (place_bet_v2 / anchor_bet / refund_stalled_bet). Every caller checks rules detection = 3 first.
 *
 *  - build*: pure builders over an Anchor program of the NEW IDL (src/v3/program.ts). They take every account explicitly,
 *    so test/v3/games-builders.test.ts encodes them offline against the IDL and test/localnet/ drives them on a validator.
 *  - the actions: read what they need from X1, write a sealed game's secret to this browser's store BEFORE the transaction
 *    that commits to it (src/v3/sealed.ts), then send with a measured compute-unit limit (lib/cu.ts).
 *  - Moon Wars moves are signed by a move key generated in this browser and funded once at create / join (WAR_MOVE_KEY_FUND),
 *    so the seed, the reveal and every move need no wallet pop-up within the short windows; the wallet can always sign
 *    instead, and the leftover goes back to the wallet when the match is paid out or cancelled.
 *
 * Games of chance and player-versus-player stakes: you can lose the whole stake; not for anyone under 18 or where such
 * games are prohibited.
 */
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY, Transaction } from '@solana/web3.js';
import { applyCu, withCu } from '../lib/cu';
import { readConnection, type X1Provider } from '../lib/protocol';
import { getProgramV3 } from './program';
import { PROGRAM_PK } from './detect';
import { V3_PDA } from './extra';
import {
    COINFLIP_CHANCE_BPS, DUEL_MIN_STAKE, MAX_CHANCE_BPS, MAX_TARGET_BPS, MIN_CHANCE_BPS, MIN_STAKE, MIN_TARGET_BPS, RTP_NUMERATOR, WAR_MIN_STAKE,
} from './games-constants';
import {
    browserSecrets, duelCommitment, duelJoinCommitment, fromHex32, randomHex32, toHex, warEntropyCommitment, warJoinCommitment, type SecretsStore,
} from './sealed';

const enc = (s: string) => new TextEncoder().encode(s);
const u64 = (n: number | bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const pda = (...s: Uint8Array[]) => PublicKey.findProgramAddressSync(s, PROGRAM_PK)[0];
const bn = (n: number | bigint | string) => new anchor.BN(n.toString());
const arr32 = (h: string | Uint8Array) => Array.from(typeof h === 'string' ? fromHex32(h) : h);

export const GAME_PDA = {
    player: (owner: PublicKey) => pda(enc('player'), owner.toBytes()),
    bet: (playerState: PublicKey, nonce: number | bigint) => pda(enc('bet'), playerState.toBytes(), u64(nonce)),
    duel: (creator: PublicKey, nonce: number | bigint) => pda(enc('duel'), creator.toBytes(), u64(nonce)),
    war: (creator: PublicKey, nonce: number | bigint) => pda(enc('war'), creator.toBytes(), u64(nonce)),
    bankrollVault: () => pda(enc('bankroll_vault')),
};

/** XNT sent to the browser move key at create / join: about 250 moves at ≈ 0.0002 XNT each; the rest comes back. */
export const WAR_MOVE_KEY_FUND = 50_000_000n;

// ── house odds (games.rs game_odds; the program refuses anything else) ─────────────────────────────────────────
export const GAME_ID = { COINFLIP: 0, HIGHLOW: 1, VOIDRUSH: 2 } as const;
/** [chance in bps, payout in bps], or null when the program would refuse the parameters. */
export function houseOdds(game: number, param: number, choice: number): [number, number] | null {
    if (game === 0) return choice <= 1 ? [COINFLIP_CHANCE_BPS, Math.floor(RTP_NUMERATOR / COINFLIP_CHANCE_BPS)] : null;
    if (game === 1) return choice <= 1 && param >= MIN_CHANCE_BPS && param <= MAX_CHANCE_BPS ? [param, Math.floor(RTP_NUMERATOR / param)] : null;
    if (game === 2) return param >= MIN_TARGET_BPS && param <= MAX_TARGET_BPS ? [Math.floor(RTP_NUMERATOR / param), param] : null;
    return null;
}
/** games.rs is_win. */
export function houseIsWin(game: number, choice: number, chanceBps: number, roll: number): boolean {
    if (game === 0) return (roll < 5_000) === (choice === 0);
    if (game === 1) return choice === 0 ? roll < chanceBps : roll >= 10_000 - chanceBps;
    return roll < chanceBps;
}
const BPS = 10_000n;
const STAKE_STEP = 100_000n;
/**
 * Largest stake (lamports) place_bet_v2 accepts now for a payout multiple, from games.rs bet_limits: net win ≤ 0.25% of
 * the free bankroll; every unsettled payout ≤ 5% of the bankroll after the bet; the keeper bond covers every pending payout
 * plus the Jackpot pots drawing. `vault` = bankroll lamports above rent, `reserved` = config.bankroll_reserved. The daily
 * and 7-day limits are left to the program (it refuses with a clear message). Rounded down to 4 decimals.
 */
export function maxStakeV3(payoutBps: number, vault: bigint, reserved: bigint, bond: bigint, jackpotReserved: bigint): bigint {
    const m = BigInt(Math.floor(payoutBps));
    if (m <= BPS || vault <= reserved) return 0n;
    const free = vault - reserved;
    const cap1 = ((free * 25n) / BPS) * BPS / (m - BPS);
    // reserved + payout ≤ 5% × (vault + stake − edge): stake × (m − 500 × 0.985) ≤ 500 × vault − reserved × BPS (scaled by BPS)
    const lhs = m * BPS - 500n * 9_850n;
    const rhs = BPS * (500n * vault - reserved * BPS);
    const cap2 = rhs <= 0n ? 0n : (rhs) / lhs;
    // bond ≥ reserved + payout + jackpotReserved
    const room = bond - reserved - jackpotReserved;
    const cap3 = room <= 0n ? 0n : (room * BPS) / m;
    let cap = cap1 < cap2 ? cap1 : cap2;
    if (cap3 < cap) cap = cap3;
    return (cap / STAKE_STEP) * STAKE_STEP;
}

// ── builders (pure: every account explicit) ──────────────────────────────────────────────────────────────────
type P = anchor.Program;
const none = SystemProgram.programId;

export function buildOpenPlayer(program: P, owner: PublicKey) {
    return program.methods.openPlayer().accountsPartial({ playerState: GAME_PDA.player(owner), owner, systemProgram: none });
}
export function buildCreateDuel(program: P, a: { owner: PublicKey; nonce: bigint; stake: bigint; commitment: Uint8Array }) {
    const duel = GAME_PDA.duel(a.owner, a.nonce);
    return {
        duel,
        builder: program.methods.createDuel(bn(a.stake), Array.from(a.commitment)).accountsPartial({
            config: V3_PDA.config(), creatorState: GAME_PDA.player(a.owner), duel, owner: a.owner, asset: none, record: none, collection: none, systemProgram: none,
        }),
    };
}
export function buildJoinDuelSealed(program: P, a: { duel: PublicKey; opponent: PublicKey; commitment: Uint8Array }) {
    return program.methods.joinDuelSealed(Array.from(a.commitment)).accountsPartial({
        config: V3_PDA.config(), duel: a.duel, opponentState: GAME_PDA.player(a.opponent), opponent: a.opponent, asset: none, record: none, collection: none,
    });
}
export function buildRevealDuelJoin(program: P, a: { duel: PublicKey; opponent: PublicKey; element: number; salt: string }) {
    return program.methods.revealDuelJoin(a.element, arr32(a.salt)).accountsPartial({ duel: a.duel, opponent: a.opponent });
}
export interface DuelAccounts { creator: PublicKey; opponent: PublicKey; rentPayer: PublicKey }
const resolveDuel = (duel: PublicKey, d: DuelAccounts, architect: PublicKey) => ({
    config: V3_PDA.config(), duel, creatorState: GAME_PDA.player(d.creator), opponentState: GAME_PDA.player(d.opponent), rewardVault: V3_PDA.rewardVault(),
    drawVault: V3_PDA.drawVault(), architect, rentPayer: d.rentPayer,
});
export function buildRevealDuel(program: P, a: { duel: PublicKey; d: DuelAccounts; architect: PublicKey; element: number; salt: string }) {
    return program.methods.revealDuel(a.element, arr32(a.salt)).accountsPartial({ resolve: resolveDuel(a.duel, a.d, a.architect), creator: a.d.creator });
}
export function buildClaimDuelTimeout(program: P, a: { duel: PublicKey; d: DuelAccounts; architect: PublicKey }) {
    return program.methods.claimDuelTimeout().accountsPartial(resolveDuel(a.duel, a.d, a.architect));
}
export function buildCancelDuel(program: P, a: { duel: PublicKey; creator: PublicKey }) {
    return program.methods.cancelDuel().accountsPartial({ duel: a.duel, creatorState: GAME_PDA.player(a.creator), creator: a.creator });
}
export function buildCreateWarSealed(program: P, a: { owner: PublicKey; nonce: bigint; stake: bigint; moveKey: PublicKey; commitment: Uint8Array }) {
    const war = GAME_PDA.war(a.owner, a.nonce);
    return {
        war,
        builder: program.methods.createWarSealed(bn(a.stake), a.moveKey, Array.from(a.commitment)).accountsPartial({
            config: V3_PDA.config(), creatorState: GAME_PDA.player(a.owner), war, owner: a.owner, asset: none, record: none, collection: none, systemProgram: none,
        }),
    };
}
export function buildJoinWarSealed(program: P, a: { war: PublicKey; opponent: PublicKey; commitment: Uint8Array }) {
    return program.methods.joinWarSealed(Array.from(a.commitment)).accountsPartial({
        config: V3_PDA.config(), war: a.war, opponentState: GAME_PDA.player(a.opponent), opponent: a.opponent, asset: none, record: none, collection: none,
    });
}
export const buildSeedWar = (program: P, a: { war: PublicKey; signer: PublicKey; entropy: string }) =>
    program.methods.seedWar(arr32(a.entropy)).accountsPartial({ war: a.war, signer: a.signer });
export const buildRevealWar = (program: P, a: { war: PublicKey; signer: PublicKey; secret: string; moveKey: PublicKey }) =>
    program.methods.revealWar(arr32(a.secret), a.moveKey).accountsPartial({ war: a.war, signer: a.signer });
export type WarMove = { kind: 'summon'; hand: number } | { kind: 'attack'; attacker: number; target: number } | { kind: 'end' };
export function buildWarMove(program: P, a: { war: PublicKey; signer: PublicKey; move: WarMove }) {
    const m = a.move;
    const b = m.kind === 'summon' ? program.methods.warSummon(m.hand) : m.kind === 'attack' ? program.methods.warAttack(m.attacker, m.target) : program.methods.warEndTurn();
    return b.accountsPartial({ war: a.war, signer: a.signer });
}
export const buildClaimWarTimeout = (program: P, war: PublicKey) => program.methods.claimWarTimeout().accountsPartial({ war });
export function buildSettleWar(program: P, a: { war: PublicKey; w: DuelAccounts; architect: PublicKey }) {
    return program.methods.settleWar().accountsPartial({
        config: V3_PDA.config(), war: a.war, creatorState: GAME_PDA.player(a.w.creator), opponentState: GAME_PDA.player(a.w.opponent), rewardVault: V3_PDA.rewardVault(),
        drawVault: V3_PDA.drawVault(), architect: a.architect, rentPayer: a.w.rentPayer,
    });
}
export const buildCancelWar = (program: P, a: { war: PublicKey; creator: PublicKey }) =>
    program.methods.cancelWar().accountsPartial({ war: a.war, creatorState: GAME_PDA.player(a.creator), creator: a.creator });
export function buildPlaceBetV2(program: P, a: { owner: PublicKey; signer: PublicKey; nonce: bigint; architect: PublicKey; game: number; param: number; choice: number; stake: bigint; seed: Uint8Array }) {
    const playerState = GAME_PDA.player(a.owner);
    const bet = GAME_PDA.bet(playerState, a.nonce);
    return {
        bet,
        builder: program.methods.placeBetV2(a.game, bn(a.param), a.choice, bn(a.stake), Array.from(a.seed)).accountsPartial({
            config: V3_PDA.config(), playerState, bet, bankrollVault: GAME_PDA.bankrollVault(), rewardVault: V3_PDA.rewardVault(), architect: a.architect,
            signer: a.signer, systemProgram: none, keeperSeat: V3_PDA.houseKeeper(),
        }),
    };
}
export const buildAnchorBet = (program: P, bet: PublicKey) => program.methods.anchorBet().accountsPartial({ bet, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY });
export function buildRefundStalledBet(program: P, a: { bet: PublicKey; playerState: PublicKey; rentPayer: PublicKey }) {
    return program.methods.refundStalledBet().accountsPartial({
        config: V3_PDA.config(), bet: a.bet, playerState: a.playerState, bankrollVault: GAME_PDA.bankrollVault(), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
        rentPayer: a.rentPayer, keeperSeat: V3_PDA.houseKeeper(), rewardVault: V3_PDA.rewardVault(),
    });
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────────
const acc = (program: P) => program.account as any;
export interface Keyed<T> { publicKey: PublicKey; account: T }
export interface DuelV3 { creator: PublicKey; nonce: anchor.BN; stake: anchor.BN; commitment: number[]; opponent: PublicKey; opponentElement: number; creatorElement: number; state: number; deadline: anchor.BN; opponentCommitment: number[]; rentPayer: PublicKey }
export interface WarV3 { creator: PublicKey; opponent: PublicKey; nonce: anchor.BN; stake: anchor.BN; state: number; targetSlot: anchor.BN; turn: number; round: number; deadline: anchor.BN; keys: PublicKey[]; sides: any[]; winner: PublicKey; draw: boolean; timeout: boolean; rentPayer: PublicKey }
export interface BetV3 { playerState: PublicKey; owner: PublicKey; rentPayer: PublicKey; game: number; choice: number; chanceBps: anchor.BN; stake: anchor.BN; payout: anchor.BN; seed: number[]; targetSlot: anchor.BN; nonce: anchor.BN }

const uniq = <T,>(lists: Keyed<T>[][]) => { const m = new Map<string, Keyed<T>>(); for (const l of lists) for (const x of l) m.set(x.publicKey.toBase58(), x); return [...m.values()]; };
/** Open duels (anyone may join) and every duel `owner` created or joined. Duel layout: creator @8, opponent @88, state @122. */
export async function fetchDuelsV3(owner: PublicKey | null, connection: Connection = readConnection): Promise<Keyed<DuelV3>[]> {
    const program = await getProgramV3(null, connection);
    const q = (f: any[]) => acc(program).duel.all(f) as Promise<Keyed<DuelV3>[]>;
    return uniq(await Promise.all([
        q([{ memcmp: { offset: 122, bytes: '1' } }]),
        owner ? q([{ memcmp: { offset: 8, bytes: owner.toBase58() } }]) : Promise.resolve([]),
        owner ? q([{ memcmp: { offset: 88, bytes: owner.toBase58() } }]) : Promise.resolve([]),
    ]));
}
/** Open matches and every match `owner` plays. War layout: creator @8, opponent @40, state @88. */
export async function fetchWarsV3(owner: PublicKey | null, connection: Connection = readConnection): Promise<Keyed<WarV3>[]> {
    const program = await getProgramV3(null, connection);
    const q = (f: any[]) => acc(program).war.all(f) as Promise<Keyed<WarV3>[]>;
    return uniq(await Promise.all([
        q([{ memcmp: { offset: 88, bytes: '1' } }]),
        owner ? q([{ memcmp: { offset: 8, bytes: owner.toBase58() } }]) : Promise.resolve([]),
        owner ? q([{ memcmp: { offset: 40, bytes: owner.toBase58() } }]) : Promise.resolve([]),
    ]));
}
/** The keeper bets of `owner` still open (Bet.owner @40); legacy bets are left to the live panel's exits. */
export async function fetchMyKeeperBets(owner: PublicKey, connection: Connection = readConnection): Promise<Keyed<BetV3>[]> {
    const program = await getProgramV3(null, connection);
    const all = (await acc(program).bet.all([{ memcmp: { offset: 40, bytes: owner.toBase58() } }])) as Keyed<BetV3>[];
    return all.filter((b) => (b.account.game & 0x80) !== 0);
}
export async function fetchPlayerV3(owner: PublicKey, connection: Connection = readConnection): Promise<{ balance: bigint; nonce: bigint } | null> {
    const program = await getProgramV3(null, connection);
    const ps = await acc(program).playerState.fetchNullable(GAME_PDA.player(owner));
    return ps ? { balance: BigInt(ps.balance.toString()), nonce: BigInt(ps.nonce.toString()) } : null;
}
/** Bankroll free value and reservations for the stake limits (vault lamports above rent, config.bankroll_reserved). */
export async function fetchBankrollV3(connection: Connection = readConnection): Promise<{ vault: bigint; reserved: bigint }> {
    const program = await getProgramV3(null, connection);
    const [info, cfg] = await Promise.all([connection.getAccountInfo(GAME_PDA.bankrollVault()), acc(program).config.fetch(V3_PDA.config())]);
    if (!info) return { vault: 0n, reserved: BigInt(cfg.bankrollReserved.toString()) };
    const rent = BigInt(await connection.getMinimumBalanceForRentExemption(info.data.length));
    const lam = BigInt(info.lamports);
    return { vault: lam > rent ? lam - rent : 0n, reserved: BigInt(cfg.bankrollReserved.toString()) };
}
/** What a closed keeper bet paid, from its last transactions' events (BetSettled / BetRefunded); null when not found. */
export async function fetchBetOutcome(bet: PublicKey, connection: Connection = readConnection): Promise<{ kind: 'settled'; won: boolean; payout: bigint; roll: number; tx: string } | { kind: 'refunded'; reason: number; amount: bigint; tx: string } | null> {
    const program = await getProgramV3(null, connection);
    const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));
    const sigs = await connection.getSignaturesForAddress(bet, { limit: 10 }).catch(() => []);
    for (const s of sigs) {
        if (s.err) continue;
        const t = await connection.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
        for (const e of parser.parseLogs(t?.meta?.logMessages ?? [], false)) {
            const name = e.name.charAt(0).toUpperCase() + e.name.slice(1);
            const d = e.data as any;
            if (!d?.bet || !new PublicKey(d.bet).equals(bet)) continue;
            if (name === 'BetSettled') return { kind: 'settled', won: !!d.won, payout: BigInt(d.payout.toString()), roll: Number(d.roll.toString()), tx: s.signature };
            if (name === 'BetRefunded') return { kind: 'refunded', reason: Number(d.reason), amount: BigInt(d.stake.toString()), tx: s.signature };
        }
    }
    return null;
}

// ── wallet actions ──────────────────────────────────────────────────────────────────────────────────────────
const me = (p: X1Provider) => new PublicKey(p.publicKey.toString());
const send = (p: X1Provider, name: string, builder: any) => withCu(builder, name, me(p), readConnection);
async function architectOf(program: P): Promise<PublicKey> { return (await acc(program).config.fetch(V3_PDA.config())).architect; }

/** The game wallet (opens it when missing) and its nonce, read with the new IDL. */
export async function ensurePlayerV3(p: X1Provider): Promise<{ nonce: bigint; balance: bigint }> {
    const program = await getProgramV3(p, readConnection);
    let ps = await fetchPlayerV3(me(p));
    if (!ps) {
        await send(p, 'open_player', buildOpenPlayer(program, me(p)));
        ps = await fetchPlayerV3(me(p));
        if (!ps) throw new Error('The game wallet was not found after opening it. Try again in a moment.');
    }
    return ps;
}
const pickElement = (el: number) => {
    if (!Number.isInteger(el) || el < 0 || el > 3) throw new Error('Choose an element.');
    return el;
};

/** Creates a sealed duel: element and salt are stored in this browser first; no Artifact is needed. */
export async function createDuelV3(p: X1Provider, stake: bigint, element: number, store: SecretsStore = browserSecrets()) {
    if (stake < DUEL_MIN_STAKE) throw new Error('The minimum duel stake is 0.1 XNT. Nothing was sent.');
    const program = await getProgramV3(p, readConnection);
    const { nonce, balance } = await ensurePlayerV3(p);
    if (balance < stake) throw new Error('Your game balance is below the stake. Deposit first. Nothing was sent.');
    const duel = GAME_PDA.duel(me(p), nonce);
    const { record } = store.getOrCreate('duel-create', duel.toBase58(), () => ({ element: pickElement(element), salt: randomHex32() }));
    const { builder } = buildCreateDuel(program, { owner: me(p), nonce, stake, commitment: duelCommitment(record.element as number, record.salt as string, duel) });
    const tx = await send(p, 'create_duel', builder);
    store.annotate('duel-create', duel.toBase58(), { tx });
    return { tx, duel };
}

/** Joins sealed (secret stored first), waits for the next second on X1, then opens the element (a second signature). */
export async function joinDuelV3(p: X1Provider, duel: PublicKey, element: number, store: SecretsStore = browserSecrets(), onJoined?: (tx: string) => void) {
    const program = await getProgramV3(p, readConnection);
    const d = (await acc(program).duel.fetch(duel)) as DuelV3;
    if (d.state !== 0) throw new Error('This duel is not open any more. Nothing was sent.');
    if (d.creator.equals(me(p))) throw new Error('You created this duel. Nothing was sent.');
    const { balance } = await ensurePlayerV3(p);
    if (balance < BigInt(d.stake.toString())) throw new Error('Your game balance is below the stake. Deposit first. Nothing was sent.');
    const { record } = store.getOrCreate('duel-join', duel.toBase58(), () => ({ element: pickElement(element), salt: randomHex32() }));
    const tx = await send(p, 'join_duel_sealed', buildJoinDuelSealed(program, { duel, opponent: me(p), commitment: duelJoinCommitment(record.element as number, record.salt as string, duel, me(p)) }));
    store.annotate('duel-join', duel.toBase58(), { tx });
    onJoined?.(tx);
    // reveal_duel_join refuses the join's own second (no join + open bundle)
    const joinedAt = await chainTime();
    for (let i = 0; i < 20 && (await chainTime()) <= joinedAt; i++) await sleep(500);
    return revealDuelJoinV3(p, duel, store);
}
export async function revealDuelJoinV3(p: X1Provider, duel: PublicKey, store: SecretsStore = browserSecrets()) {
    const rec = store.get('duel-join', duel.toBase58());
    if (!rec) throw new Error('The secret of this join is not in this browser: restore your backup to open it.');
    const program = await getProgramV3(p, readConnection);
    return send(p, 'reveal_duel_join', buildRevealDuelJoin(program, { duel, opponent: me(p), element: rec.element as number, salt: rec.salt as string }));
}
/**
 * The creator's sealed element and salt of a duel: this browser's store, or the record the live site wrote for a duel
 * created before the upgrade (localStorage moonforge_duel_<duel>: { element, salt: number[] }).
 */
export function creatorSecretV3(duel: PublicKey, store: SecretsStore = browserSecrets()): { element: number; salt: string } | null {
    const rec = store.get('duel-create', duel.toBase58());
    if (rec) return { element: rec.element as number, salt: rec.salt as string };
    try {
        const legacy = JSON.parse(localStorage.getItem(`moonforge_duel_${duel.toBase58()}`) || 'null');
        if (legacy && Number.isInteger(legacy.element) && Array.isArray(legacy.salt) && legacy.salt.length === 32) return { element: legacy.element, salt: toHex(Uint8Array.from(legacy.salt)) };
    } catch { /* storage blocked or not JSON */ }
    return null;
}
export async function revealDuelV3(p: X1Provider, duel: PublicKey, store: SecretsStore = browserSecrets()) {
    const rec = creatorSecretV3(duel, store);
    if (!rec) throw new Error('The secret of this duel is not in this browser: restore your backup to reveal it.');
    const program = await getProgramV3(p, readConnection);
    const d = (await acc(program).duel.fetch(duel)) as DuelV3;
    if (d.opponentElement === 255) throw new Error('The joiner has not opened its element yet. Nothing was sent.');
    return send(p, 'reveal_duel', buildRevealDuel(program, { duel, d, architect: await architectOf(program), element: rec.element, salt: rec.salt }));
}
export async function claimDuelTimeoutV3(p: X1Provider, duel: PublicKey) {
    const program = await getProgramV3(p, readConnection);
    const d = (await acc(program).duel.fetch(duel)) as DuelV3;
    return send(p, 'claim_duel_timeout', buildClaimDuelTimeout(program, { duel, d, architect: await architectOf(program) }));
}
export async function cancelDuelV3(p: X1Provider, duel: PublicKey) {
    const program = await getProgramV3(p, readConnection);
    return send(p, 'cancel_duel', buildCancelDuel(program, { duel, creator: me(p) }));
}

// Moon Wars: the browser move key
const keyRecord = (k: Keypair) => ({ publicKey: k.publicKey.toBase58(), secretKey: toHex(k.secretKey) });
/** The move key this browser holds for a match, or null. */
export function warMoveKeyV3(war: PublicKey, store: SecretsStore = browserSecrets()): Keypair | null {
    const r = store.get('war-key', war.toBase58());
    if (!r) return null;
    try { return Keypair.fromSecretKey(Uint8Array.from((r.secretKey as string).match(/.{2}/g)!, (x) => parseInt(x, 16))); } catch { return null; }
}
const fundIx = (from: PublicKey, to: PublicKey) => SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: Number(WAR_MOVE_KEY_FUND) });

/** Creates a sealed match: move key and entropy stored in this browser first, the move key funded in the same transaction. */
export async function createWarV3(p: X1Provider, stake: bigint, store: SecretsStore = browserSecrets()) {
    if (stake < WAR_MIN_STAKE) throw new Error('The minimum match stake is 0.1 XNT. Nothing was sent.');
    const program = await getProgramV3(p, readConnection);
    const { nonce, balance } = await ensurePlayerV3(p);
    if (balance < stake) throw new Error('Your game balance is below the stake. Deposit first. Nothing was sent.');
    const war = GAME_PDA.war(me(p), nonce);
    const kr = store.getOrCreate('war-key', war.toBase58(), () => keyRecord(Keypair.generate())).record;
    const { record } = store.getOrCreate('war-create', war.toBase58(), () => ({ entropy: randomHex32(), moveKey: kr.publicKey }));
    const moveKey = new PublicKey(record.moveKey as string);
    const { builder } = buildCreateWarSealed(program, { owner: me(p), nonce, stake, moveKey, commitment: warEntropyCommitment(record.entropy as string, war) });
    const tx = await send(p, 'create_war_sealed', builder.postInstructions([fundIx(me(p), moveKey)]));
    store.annotate('war-create', war.toBase58(), { tx });
    return { tx, war };
}
/** Joins a sealed match: move key and secret stored first; the move key is committed in the join and funded with it. */
export async function joinWarV3(p: X1Provider, war: PublicKey, store: SecretsStore = browserSecrets()) {
    const program = await getProgramV3(p, readConnection);
    const w = (await acc(program).war.fetch(war)) as WarV3;
    if (w.state !== 0) throw new Error('This match is not open any more. Nothing was sent.');
    if (w.creator.equals(me(p))) throw new Error('You created this match. Nothing was sent.');
    const { balance } = await ensurePlayerV3(p);
    if (balance < BigInt(w.stake.toString())) throw new Error('Your game balance is below the stake. Deposit first. Nothing was sent.');
    const kr = store.getOrCreate('war-key', war.toBase58(), () => keyRecord(Keypair.generate())).record;
    const { record } = store.getOrCreate('war-join', war.toBase58(), () => ({ secret: randomHex32(), moveKey: kr.publicKey }));
    const moveKey = new PublicKey(record.moveKey as string);
    const tx = await send(p, 'join_war_sealed', buildJoinWarSealed(program, { war, opponent: me(p), commitment: warJoinCommitment(record.secret as string, war, me(p), moveKey) }).postInstructions([fundIx(me(p), moveKey)]));
    store.annotate('war-join', war.toBase58(), { tx });
    return { tx, war };
}

/** Sends a war instruction signed by this browser's move key (no pop-up) when it has one, else by the wallet. */
async function sendWar(p: X1Provider, war: PublicKey, name: string, build: (program: P, signer: PublicKey) => any, store: SecretsStore) {
    const key = warMoveKeyV3(war, store);
    if (key && (await readConnection.getBalance(key.publicKey, 'confirmed').catch(() => 0)) > 20_000) {
        const program = await getProgramV3(null, readConnection);
        const tx: Transaction = await build(program, key.publicKey).transaction();
        tx.feePayer = key.publicKey;
        await applyCu(readConnection, tx, key.publicKey, name);
        tx.recentBlockhash = (await readConnection.getLatestBlockhash('confirmed')).blockhash;
        tx.sign(key);
        const sig = await readConnection.sendRawTransaction(tx.serialize());
        await readConnection.confirmTransaction(sig, 'confirmed');
        return sig;
    }
    const program = await getProgramV3(p, readConnection);
    return send(p, name, build(program, me(p)));
}
/** The creator opens its entropy (within 10 minutes of the join). */
export async function seedWarV3(p: X1Provider, war: PublicKey, store: SecretsStore = browserSecrets()) {
    const rec = store.get('war-create', war.toBase58());
    if (!rec) throw new Error('The entropy of this match is not in this browser: restore your backup, or the match becomes a draw when the seed window ends.');
    return sendWar(p, war, 'seed_war', (program, signer) => buildSeedWar(program, { war, signer, entropy: rec.entropy as string }), store);
}
/** The joiner opens its secret (within 2 minutes of the seed): the match starts. */
export async function revealWarV3(p: X1Provider, war: PublicKey, store: SecretsStore = browserSecrets()) {
    const rec = store.get('war-join', war.toBase58());
    if (!rec) throw new Error('The secret of this join is not in this browser: restore your backup, or the creator wins when the reveal window ends.');
    return sendWar(p, war, 'reveal_war', (program, signer) => buildRevealWar(program, { war, signer, secret: rec.secret as string, moveKey: new PublicKey(rec.moveKey as string) }), store);
}
export const warMoveV3 = (p: X1Provider, war: PublicKey, move: WarMove, store: SecretsStore = browserSecrets()) =>
    sendWar(p, war, move.kind === 'summon' ? 'war_summon' : move.kind === 'attack' ? 'war_attack' : 'war_end_turn', (program, signer) => buildWarMove(program, { war, signer, move }), store);
export async function claimWarTimeoutV3(p: X1Provider, war: PublicKey) {
    const program = await getProgramV3(p, readConnection);
    return send(p, 'claim_war_timeout', buildClaimWarTimeout(program, war));
}
export async function settleWarV3(p: X1Provider, war: PublicKey, store: SecretsStore = browserSecrets()) {
    const program = await getProgramV3(p, readConnection);
    const w = (await acc(program).war.fetch(war)) as WarV3;
    const sig = await send(p, 'settle_war', buildSettleWar(program, { war, w, architect: await architectOf(program) }));
    await sweepMoveKeyV3(p, war, store).catch(() => undefined);
    return sig;
}
export async function cancelWarV3(p: X1Provider, war: PublicKey, store: SecretsStore = browserSecrets()) {
    const program = await getProgramV3(p, readConnection);
    const sig = await send(p, 'cancel_war', buildCancelWar(program, { war, creator: me(p) }));
    await sweepMoveKeyV3(p, war, store).catch(() => undefined);
    return sig;
}
/** Sends everything left on this browser's move key back to the wallet (the move key pays its own fee). */
export async function sweepMoveKeyV3(p: X1Provider, war: PublicKey, store: SecretsStore = browserSecrets()): Promise<string | null> {
    const key = warMoveKeyV3(war, store);
    if (!key) return null;
    const lamports = await readConnection.getBalance(key.publicKey, 'confirmed');
    if (lamports <= 0) return null;
    const build = (amount: number) => {
        const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: key.publicKey, toPubkey: me(p), lamports: amount }));
        tx.feePayer = key.publicKey;
        return tx;
    };
    const probe = build(lamports);
    probe.recentBlockhash = (await readConnection.getLatestBlockhash('confirmed')).blockhash;
    const fee = (await readConnection.getFeeForMessage(probe.compileMessage(), 'confirmed')).value ?? 5_000;
    if (lamports <= fee) return null;
    const tx = build(lamports - fee);
    tx.recentBlockhash = probe.recentBlockhash;
    tx.sign(key);
    const sig = await readConnection.sendRawTransaction(tx.serialize());
    await readConnection.confirmTransaction(sig, 'confirmed');
    return sig;
}

// House bets on the keeper chain
/** Places a house bet (place_bet_v2): the stake is debited from the game wallet; the result needs the anchor and the keeper's reveal. */
export async function placeBetV3(p: X1Provider, game: number, param: number, choice: number, stake: bigint) {
    if (stake < MIN_STAKE) throw new Error('The minimum stake is 0.01 XNT. Nothing was sent.');
    if (!houseOdds(game, param, choice)) throw new Error('These odds are outside what the program accepts. Nothing was sent.');
    const program = await getProgramV3(p, readConnection);
    const { nonce, balance } = await ensurePlayerV3(p);
    if (balance < stake) throw new Error('Your game balance is below the stake. Deposit first. Nothing was sent.');
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const name = game === 0 ? 'place_bet_v2:coinflip' : game === 1 ? 'place_bet_v2:highlow' : 'place_bet_v2:voidrush';
    const { bet, builder } = buildPlaceBetV2(program, { owner: me(p), signer: me(p), nonce, architect: await architectOf(program), game, param, choice, stake, seed });
    const tx = await send(p, name, builder);
    return { tx, bet };
}
/** Anchors a bet (permissionless; anyone may pay the fee): retried while its anchor block does not exist yet. */
export async function anchorBetV3(p: X1Provider, bet: PublicKey, tries = 12) {
    const program = await getProgramV3(p, readConnection);
    let last: unknown = null;
    for (let i = 0; i < tries; i++) {
        const b = (await acc(program).bet.fetchNullable(bet)) as BetV3 | null;
        if (!b) throw new Error('This bet is already settled or refunded.');
        if ((b.game & 0x40) !== 0) return null; // anchored by someone else (the keeper)
        try { return await send(p, 'anchor_bet', buildAnchorBet(program, bet)); } catch (e: any) {
            last = e;
            if (!/NotReady/.test(`${e?.message ?? e} ${JSON.stringify(e?.logs ?? [])}`)) throw e;
            await sleep(600);
        }
    }
    throw last ?? new Error('The anchor block did not appear in time: try again within about 3 minutes.');
}
/** Refunds a stalled bet (permissionless): never anchored → the whole stake; stalled or skipped by the keeper → the payout. */
export async function refundStalledBetV3(p: X1Provider, bet: PublicKey) {
    const program = await getProgramV3(p, readConnection);
    const b = (await acc(program).bet.fetch(bet)) as BetV3;
    return send(p, 'refund_stalled_bet', buildRefundStalledBet(program, { bet, playerState: b.playerState, rentPayer: b.rentPayer }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function chainTime(): Promise<number> {
    const slot = await readConnection.getSlot('confirmed');
    return (await readConnection.getBlockTime(slot).catch(() => null)) ?? Math.floor(Date.now() / 1000);
}
