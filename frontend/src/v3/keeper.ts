/**
 * House keeper seat (rules 3): the hash-chain keeper that draws house bets and the Jackpot after the upgrade.
 *
 * Gating rule for the site (r9): house games and the Jackpot are offered ONLY while the chain shows a live keeper. Nothing
 * here is a constant a later release has to flip: after the freeze nobody may ever change the site, so the decision is
 * read from X1 on every visit (keeperLiveness):
 *   1. the seat exists, decodes and names a keeper key;
 *   2. its committed hash chain has positions left (place_bet_v2 refuses KeeperNotArmed otherwise);
 *   3. its bond is at least KEEPER_BOND_MIN (20 XNT, which also covers the largest Jackpot pot);
 *   4. it has not announced a bond withdrawal (a keeper on its 7-day notice is leaving);
 *   5. not dead: an arm, reveal or settle within KEEPER_DEAD_DELAY (28 days, the program's own dead-seat rule). Idle time
 *      alone hides nothing sooner: with the games hidden nobody bets, so a running keeper would have nothing to settle and
 *      the games could never come back. Its last activity is shown as information (lastKeeperActivity);
 *   6. pending within limits: at most JACKPOT_MAX_BACKLOG positions wait for a reveal (the program's own Jackpot limit);
 *   7. the published service levels, measured on the bets that wait for it now: no anchored bet waits for its reveal longer
 *      than KEEPER_REVEAL_SLA_SLOTS (about 10 minutes), no bet stays unanchored longer than KEEPER_ANCHOR_SLA_SLOTS
 *      (150 slots; anyone may anchor, and a running keeper does), and no bet is already refundable as stalled or skipped.
 * A failed read never shows the games (fail-closed). When the games are hidden the page says which check failed and how
 * anyone can become the keeper (keeperOpening): from KEEPER_OPEN_TS (2026-12-16 00:00 UTC) anyone may create a seat that
 * was never created, with its own chain and a bond of at least 20 XNT; a seat idle for KEEPER_DEAD_DELAY (28 days) can be
 * taken by anyone. The exits of bets and entries already made (settle, refund, withdraw) never depend on this gate.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { decodeHouseKeeper, type HouseKeeperView } from './layout';
import { V3_PDA } from './extra';
import { KEEPER_BOND_MIN, XNT } from './constants';
import { PROGRAM_PK } from './detect';
import {
    BET_ANCHORED, BET_KEEPER, BET_SLOT_BITS, JACKPOT_MAX_BACKLOG, KEEPER_DEAD_DELAY, KEEPER_OPEN_TS, KEEPER_STALL_SLOTS,
} from './games-constants';

/** Check 5: idle time alone hides the games only once the seat is dead by the program's rule (KEEPER_DEAD_DELAY, 28 days). */
export const KEEPER_RECENT_S = KEEPER_DEAD_DELAY;
/** Check 7: the published reveal service level, 10 minutes, in slots (≈ 0.368 s per slot on X1). */
export const KEEPER_REVEAL_SLA_SLOTS = 1_632;
/** Check 7: the published anchor service level, 150 slots. */
export const KEEPER_ANCHOR_SLA_SLOTS = 150;
/** SlotHashes keeps the last 512 slots: a bet not anchored within them is refunded its whole stake. */
export const SLOT_HASHES_DEPTH = 512;

const DEFAULT_KEY = '11111111111111111111111111111111';
const SLOT_MASK = (1n << BET_SLOT_BITS) - 1n;

export async function fetchHouseKeeper(connection: Connection): Promise<HouseKeeperView | null> {
    const info = await connection.getAccountInfo(V3_PDA.houseKeeper());
    if (!info || !info.owner.equals(PROGRAM_PK)) return null;
    return decodeHouseKeeper(new Uint8Array(info.data));
}

/** Pure: a seat with a keeper key set and a bond ≥ 20 XNT (checks 1 and 3). */
export function keeperSeatReady(k: HouseKeeperView | null): boolean {
    if (!k) return false;
    if (k.keeper.toBase58() === DEFAULT_KEY) return false;
    return k.bond >= KEEPER_BOND_MIN;
}

/** The two Bet fields the gate reads (raw: Bet.game and Bet.target_slot). */
export interface BetLike { game: number; targetSlot: bigint }
/** Where a keeper bet stands for the gate: unanchored / waiting for the reveal / refundable (stalled or skipped). */
export function keeperBetWait(b: BetLike, revealed: bigint, slot: bigint): { keeper: boolean; index: bigint; anchor: bigint; anchored: boolean; refundable: boolean; age: bigint } {
    const keeper = (b.game & BET_KEEPER) !== 0;
    const index = b.targetSlot >> BET_SLOT_BITS;
    const anchor = b.targetSlot & SLOT_MASK;
    const anchored = (b.game & BET_ANCHORED) !== 0;
    const age = slot > anchor ? slot - anchor : 0n;
    const skipped = index < revealed;
    const refundable = keeper && (skipped || (anchored ? age > BigInt(KEEPER_STALL_SLOTS) : age > BigInt(SLOT_HASHES_DEPTH)));
    return { keeper, index, anchor, anchored, refundable, age };
}

export interface LivenessCheck { id: 'seat' | 'armed' | 'bond' | 'leaving' | 'recent' | 'backlog' | 'reveal' | 'anchor' | 'stalled' | 'read'; ok: boolean; text: string }
export interface Liveness { live: boolean; checks: LivenessCheck[]; failed: LivenessCheck[] }

const xnt = (l: bigint) => (Number(l) / Number(XNT)).toLocaleString('en-US', { maximumFractionDigits: 2 });
const minutes = (slots: bigint) => Math.max(1, Math.round((Number(slots) * 0.368) / 60));

/**
 * Pure: is a keeper live, from chain facts only? `bets` = every Bet account of the program now (null = the read failed),
 * `slot` / `now` = X1's current slot and unix time. Every check is listed with its plain reason.
 */
export function keeperLiveness(k: HouseKeeperView | null, bets: BetLike[] | null, slot: bigint | number, now: number): Liveness {
    const s = BigInt(slot);
    const checks: LivenessCheck[] = [];
    const add = (id: LivenessCheck['id'], ok: boolean, text: string) => checks.push({ id, ok, text });
    const seated = !!k && k.keeper.toBase58() !== DEFAULT_KEY;
    add('seat', seated, seated ? 'A keeper seat exists.' : 'No house keeper seat exists yet.');
    if (k && seated) {
        const left = k.length > k.nextIndex ? k.length - k.nextIndex : 0n;
        add('armed', left > 0n, left > 0n ? `The keeper's hash chain has ${left.toString()} positions left.` : 'The keeper\'s hash chain has no positions left: it must re-arm before any new bet.');
        add('bond', k.bond >= KEEPER_BOND_MIN, k.bond >= KEEPER_BOND_MIN ? `The keeper bond is ${xnt(k.bond)} XNT.` : `The keeper bond is ${xnt(k.bond)} XNT, below the ${xnt(KEEPER_BOND_MIN)} XNT minimum.`);
        add('leaving', k.withdrawTs === 0n, k.withdrawTs === 0n ? 'No bond withdrawal is announced.' : 'The keeper announced a bond withdrawal (7-day notice): it is leaving.');
        const idle = now - Number(k.lastActiveTs);
        const days = Math.floor(Math.max(0, idle) / 86_400);
        add('recent', idle < KEEPER_RECENT_S, idle < KEEPER_RECENT_S ? `Last keeper activity (arm, reveal or settle): ${lastKeeperActivity(k)}; the seat is not idle for 28 days.` : `No keeper activity (arm, reveal or settle) for ${days} days: the seat is dead by the program's rule and anyone may take it.`);
        const backlog = k.nextIndex > k.revealed ? k.nextIndex - k.revealed : 0n;
        add('backlog', backlog <= BigInt(JACKPOT_MAX_BACKLOG), backlog <= BigInt(JACKPOT_MAX_BACKLOG) ? `${backlog.toString()} positions wait for a reveal.` : `${backlog.toString()} positions wait for a reveal (the program's limit is ${JACKPOT_MAX_BACKLOG}).`);
        if (bets === null) add('read', false, 'The pending bets could not be read from X1, so the keeper\'s service cannot be checked.');
        else {
            const w = bets.map((b) => keeperBetWait(b, k.revealed, s)).filter((x) => x.keeper);
            const waiting = w.filter((x) => x.anchored && !x.refundable && x.index >= k.revealed);
            const oldest = waiting.reduce((m, x) => (x.age > m ? x.age : m), 0n);
            add('reveal', oldest <= BigInt(KEEPER_REVEAL_SLA_SLOTS), oldest <= BigInt(KEEPER_REVEAL_SLA_SLOTS) ? 'No anchored bet waits longer than 10 minutes for its reveal.' : `An anchored bet has waited about ${minutes(oldest)} minutes for the keeper's reveal (service level: 10 minutes).`);
            const unanchored = w.filter((x) => !x.anchored && !x.refundable).reduce((m, x) => (x.age > m ? x.age : m), 0n);
            add('anchor', unanchored <= BigInt(KEEPER_ANCHOR_SLA_SLOTS), unanchored <= BigInt(KEEPER_ANCHOR_SLA_SLOTS) ? 'No bet waits longer than 150 slots for its anchor.' : 'A bet has waited longer than 150 slots for its anchor (service level: 150 slots).');
            const stalled = w.filter((x) => x.refundable).length;
            add('stalled', stalled === 0, stalled === 0 ? 'No bet is refundable as stalled or skipped.' : `${stalled} bet(s) are refundable because nobody anchored them in time or the keeper stalled or skipped them.`);
        }
    }
    const failed = checks.filter((c) => !c.ok);
    return { live: failed.length === 0 && seated, checks, failed };
}

/** Pure: may new house bets be offered? Only while keeperLiveness says live. */
export const newHouseBetsOffered = (l: Liveness | null) => !!l && l.live;
/** Pure: may the Jackpot be offered? The same gate (the Jackpot needs the same keeper and a 20 XNT bond). */
export const jackpotOffered = (l: Liveness | null) => !!l && l.live;
/** Pure: Be the House shows the "no house bet now" notice whenever house games are not offered. */
export const houseNoBetsNoticeShown = (l: Liveness | null) => !newHouseBetsOffered(l);

const utcDate = (ts: number) => new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
/** The seat's last arm, reveal or settle as a UTC date (information only: idle time alone hides nothing before 28 days). */
export function lastKeeperActivity(k: HouseKeeperView | null): string {
    return k && k.lastActiveTs > 0n ? utcDate(Number(k.lastActiveTs)) : 'none recorded';
}

/**
 * Pure: how anyone can become the keeper now (program rules: arm_keeper with the dated opening, take_keeper after 28 days
 * idle or by the named successor after the 7-day notice). `how` is the plain path; `when` is a UTC date, never a promise.
 */
export function keeperOpening(k: HouseKeeperView | null, now: number): { state: 'not-open-yet' | 'open' | 'takeable' | 'held'; text: string; when: string | null } {
    const seated = !!k && k.keeper.toBase58() !== DEFAULT_KEY;
    if (!seated) {
        if (now < KEEPER_OPEN_TS) {
            return {
                state: 'not-open-yet', when: utcDate(KEEPER_OPEN_TS),
                text: `No keeper seat exists. From ${utcDate(KEEPER_OPEN_TS)} anyone may create it (arm_keeper) with their own hash chain and a bond of at least ${xnt(KEEPER_BOND_MIN)} XNT, and becomes the keeper; until then only the initial keeper key can create it.`,
            };
        }
        return { state: 'open', when: null, text: `No keeper seat exists: anyone may create it now (arm_keeper) with their own hash chain and a bond of at least ${xnt(KEEPER_BOND_MIN)} XNT, and becomes the keeper.` };
    }
    const deadAt = Number(k!.lastActiveTs) + KEEPER_DEAD_DELAY;
    if (now >= deadAt) {
        return { state: 'takeable', when: null, text: `The keeper has had no arm, reveal or settle for 28 days: anyone may take the seat now (take_keeper) with their own hash chain and a bond of at least ${xnt(KEEPER_BOND_MIN)} XNT, once nothing is pending; the old keeper gets its bond back.` };
    }
    return {
        state: 'held', when: utcDate(deadAt),
        text: `The seat is held. If the keeper stays idle (no arm, reveal or settle), anyone may take it from ${utcDate(deadAt)} (take_keeper, own chain, bond of at least ${xnt(KEEPER_BOND_MIN)} XNT); the keeper may also name a successor, who takes it after 7 days.`,
    };
}

/** Every Bet account of the program (raw game byte and target_slot), for the gate. Offsets from state.rs Bet (179 bytes). */
export async function fetchAllBets(connection: Connection, bs58: (b: Uint8Array) => string, betDisc: Uint8Array): Promise<BetLike[]> {
    const accs = await connection.getProgramAccounts(PROGRAM_PK, {
        filters: [{ dataSize: 179 }, { memcmp: { offset: 0, bytes: bs58(betDisc) } }],
        dataSlice: { offset: 104, length: 66 },
    });
    return accs.map((a) => {
        const d = new Uint8Array(a.account.data);
        const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
        return { game: d[0], targetSlot: dv.getBigUint64(58, true) };
    });
}

/** The gate, read from X1: the seat, every bet, the slot and the chain time. Throws only if the seat itself cannot be read. */
export async function readKeeperLiveness(connection: Connection, bs58: (b: Uint8Array) => string, betDisc: Uint8Array): Promise<{ seat: HouseKeeperView | null; liveness: Liveness; opening: ReturnType<typeof keeperOpening>; now: number }> {
    const [seat, slot] = await Promise.all([fetchHouseKeeper(connection), connection.getSlot('confirmed')]);
    const [bets, blockTime] = await Promise.all([
        fetchAllBets(connection, bs58, betDisc).catch(() => null),
        connection.getBlockTime(slot).catch(() => null),
    ]);
    const now = blockTime ?? Math.floor(Date.now() / 1000);
    return { seat, liveness: keeperLiveness(seat, bets, slot, now), opening: keeperOpening(seat, now), now };
}

/** The Bet account discriminator read from the IDL in use (never hard-coded here). */
export const betDiscriminator = (idl: { accounts?: { name: string; discriminator?: number[] }[] }) => {
    const d = idl.accounts?.find((a) => a.name === 'Bet')?.discriminator;
    if (!d || d.length !== 8) throw new Error('The bundled IDL has no Bet discriminator');
    return Uint8Array.from(d);
};

export const keeperKeyOf = (k: HouseKeeperView | null): PublicKey | null => (k && k.keeper.toBase58() !== DEFAULT_KEY ? k.keeper : null);
