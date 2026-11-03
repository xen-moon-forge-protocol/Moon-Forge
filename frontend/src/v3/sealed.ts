/**
 * Sealed player-versus-player games of the upgraded program (rules 3): the Artifact Duel and Moon Wars.
 *
 *  - Commitments, byte for byte the program's (p2p.rs duel / duel_join_commitment, wars.rs war_entropy_commitment,
 *    war_join_commitment, war_seed_v2, first_mover) and the agent kit's (agents/kit/rules-v3.mjs). test/v3/sealed.test.ts
 *    checks them against the program's own vectors (Appendix A) and, when the kit's dependencies are installed, against
 *    the kit on fixed inputs.
 *  - The browser secrets store: a sealed game is lost if its secret is (a creator who cannot reveal loses the pot, a joiner
 *    who cannot open gives its stake to the reward pool, a Moon Wars creator who cannot seed makes the match a draw, a
 *    joiner who cannot reveal loses). So, like the kit, a secret is written BEFORE the transaction that commits to it,
 *    a retry reuses the same bytes, and a record is never replaced by different bytes. Records live in this browser's
 *    localStorage only (nothing is sent anywhere); exportSecrets() / importSecrets() make the explicit backup. A record
 *    has the kit's file shape ({ kind, account, createdAt, ... }), so a backup can also be used with the kit.
 *  - Phase rules: who acts next, until when, and what happens if the other player stops (from the program's handlers).
 *
 * Pure: no React, no network (the store takes any Storage-like object).
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { PublicKey } from '@solana/web3.js';
import {
    DUEL_JOIN_REVEAL_WINDOW, DUEL_REVEAL_WINDOW, P2P_OFFER_TTL, WAR_FIRST_TURN_GRACE, WAR_REVEAL_WINDOW, WAR_SEED_WINDOW, WAR_TIME_BANK,
    WAR_TURN_FREE, WAR_TURN_TIMEOUT, WAR_V2,
} from './games-constants';

// ── bytes ───────────────────────────────────────────────────────────────────────────────────────────────────
const enc = (s: string) => new TextEncoder().encode(s);
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex32(h: string, what = 'value'): Uint8Array {
    if (!/^[0-9a-f]{64}$/i.test(h)) throw new Error(`${what}: expected 32 bytes of hex`);
    return Uint8Array.from(h.match(/.{2}/g)!, (x) => parseInt(x, 16));
}
const bytes32 = (x: Uint8Array | string, what: string) => {
    const b = typeof x === 'string' ? fromHex32(x, what) : x;
    if (b.length !== 32) throw new Error(`${what}: expected 32 bytes`);
    return b;
};
const keyBytes = (k: PublicKey | string) => new PublicKey(k).toBytes();
export function keccak(...parts: (Uint8Array | string)[]): Uint8Array {
    const h = keccak_256.create();
    for (const p of parts) h.update(typeof p === 'string' ? enc(p) : p);
    return h.digest();
}
/** 32 random bytes as hex (crypto.getRandomValues; never Math.random). */
export function randomHex32(): string {
    return toHex(crypto.getRandomValues(new Uint8Array(32)));
}
/** utils.rs random_u64: the first 8 bytes (LE) of keccak("MOONFORGE_RNG" ‖ hash ‖ a ‖ b). */
export function randomU64(hash: Uint8Array | string, a: Uint8Array, b: Uint8Array): bigint {
    const d = keccak('MOONFORGE_RNG', bytes32(hash, 'hash'), a, b);
    return new DataView(d.buffer, d.byteOffset, 8).getBigUint64(0, true);
}

// ── commitments ─────────────────────────────────────────────────────────────────────────────────────────────
export const ELEMENTS = ['Lunar', 'Cosmic', 'Solar', 'Void'] as const;
/** opponent_element while the joiner's element is still sealed */
export const DUEL_ELEMENT_SEALED = 255;
const element = (e: number) => {
    if (!Number.isInteger(e) || e < 0 || e > 3) throw new Error('element: 0..3 (Lunar, Cosmic, Solar, Void)');
    return Uint8Array.of(e);
};
/** The creator's commitment: keccak("MOONFORGE_DUEL" ‖ element ‖ salt ‖ duel). */
export const duelCommitment = (el: number, salt: Uint8Array | string, duel: PublicKey | string) =>
    keccak('MOONFORGE_DUEL', element(el), bytes32(salt, 'salt'), keyBytes(duel));
/** The joiner's sealed commitment: keccak("MOONFORGE_DUEL_JOIN" ‖ element ‖ salt ‖ duel ‖ opponent). */
export const duelJoinCommitment = (el: number, salt: Uint8Array | string, duel: PublicKey | string, opponent: PublicKey | string) =>
    keccak('MOONFORGE_DUEL_JOIN', element(el), bytes32(salt, 'salt'), keyBytes(duel), keyBytes(opponent));
/** a beats b ⇔ b == (a + 3) % 4: Lunar > Void > Solar > Cosmic > Lunar. */
export const beats = (a: number, b: number) => b === (a + 3) % 4;
/** p2p.rs duel_winner: 'opponent' | 'creator' | 'draw' (same or opposite element). */
export function duelWinner(creatorEl: number, opponentEl: number): 'creator' | 'opponent' | 'draw' {
    if (creatorEl === opponentEl || (creatorEl + 2) % 4 === opponentEl) return 'draw';
    return beats(opponentEl, creatorEl) ? 'opponent' : 'creator';
}
/** keccak("MOONFORGE_WAR_ENTROPY" ‖ entropy ‖ war): the creator's commitment at create_war_sealed. */
export const warEntropyCommitment = (entropy: Uint8Array | string, war: PublicKey | string) =>
    keccak('MOONFORGE_WAR_ENTROPY', bytes32(entropy, 'entropy'), keyBytes(war));
/** keccak("MOONFORGE_WAR_JOIN" ‖ secret ‖ war ‖ opponent ‖ move key): the joiner's commitment at join_war_sealed. */
export const warJoinCommitment = (secret: Uint8Array | string, war: PublicKey | string, opponent: PublicKey | string, moveKey: PublicKey | string) =>
    keccak('MOONFORGE_WAR_JOIN', bytes32(secret, 'secret'), keyBytes(war), keyBytes(opponent), keyBytes(moveKey));
/** keccak("MOONFORGE_WAR_V2" ‖ entropy ‖ secret ‖ war): the seed of both decks and of the first mover. */
export const warSeedV2 = (entropy: Uint8Array | string, secret: Uint8Array | string, war: PublicKey | string) =>
    keccak('MOONFORGE_WAR_V2', bytes32(entropy, 'entropy'), bytes32(secret, 'secret'), keyBytes(war));
/** wars.rs first_mover: 0 = the creator moves first, 1 = the opponent. */
export const firstMover = (seed: Uint8Array | string) => Number(randomU64(seed, enc('MOONFORGE_WAR_FIRST'), new Uint8Array(0)) & 1n);
/** wars.rs shuffle: one side's deck from the seed (cards are drawn from the end). */
export function warShuffle(seed: Uint8Array | string, side: 0 | 1): number[] {
    const d = [0, 0, 0, 0, 1, 1, 1, 2, 2, 3];
    for (let i = d.length - 1; i >= 1; i--) {
        const r = randomU64(seed, enc('MOONFORGE_WAR_DECK'), Uint8Array.of(side, i));
        const j = Number(r % BigInt(i + 1));
        [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
}
/** A match created by the final binary (sealed start, chess clock): bit 63 of War.target_slot. */
export const isSealedWar = (targetSlot: bigint | string | number) => (BigInt(targetSlot.toString()) & WAR_V2) !== 0n;
/** Chess-clock seconds left [creator, opponent] of a sealed match once ACTIVE. */
export function warClockBanks(targetSlot: bigint | string | number): [number, number] {
    const t = BigInt(targetSlot.toString());
    return [Number((t >> 16n) & 0xffffn), Number(t & 0xffffn)];
}

// ── the browser secrets store ───────────────────────────────────────────────────────────────────────────────
export type SecretKind = 'duel-create' | 'duel-join' | 'war-create' | 'war-join' | 'war-key';
export const SECRET_KINDS: readonly SecretKind[] = ['duel-create', 'duel-join', 'war-create', 'war-join', 'war-key'];
export interface SecretRecord { kind: SecretKind; account: string; createdAt: string; [field: string]: unknown }
export interface StorageLike {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
    removeItem(k: string): void;
    key(i: number): string | null;
    readonly length: number;
}
const PREFIX = 'moonforge_v3_secret:';
export const BACKUP_FORMAT = 'moonforge-sealed-secrets';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function validRecord(r: any): r is SecretRecord {
    if (!r || typeof r !== 'object' || !SECRET_KINDS.includes(r.kind) || typeof r.account !== 'string' || !B58.test(r.account)) return false;
    const hex = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v);
    switch (r.kind as SecretKind) {
        case 'duel-create': case 'duel-join': return Number.isInteger(r.element) && r.element >= 0 && r.element <= 3 && hex(r.salt);
        case 'war-create': return hex(r.entropy) && typeof r.moveKey === 'string' && B58.test(r.moveKey);
        case 'war-join': return hex(r.secret) && typeof r.moveKey === 'string' && B58.test(r.moveKey);
        case 'war-key': return typeof r.secretKey === 'string' && /^[0-9a-f]{128}$/i.test(r.secretKey) && typeof r.publicKey === 'string' && B58.test(r.publicKey);
    }
    return false;
}
/** The secret fields of a record (what may never change once written). */
const secretFields = (r: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const k of ['element', 'salt', 'entropy', 'secret', 'moveKey', 'secretKey', 'publicKey']) if (k in r) out[k] = r[k];
    return JSON.stringify(out);
};

export class SecretsStore {
    constructor(private storage: StorageLike | null) {}
    private name(kind: SecretKind, account: string) {
        if (!SECRET_KINDS.includes(kind)) throw new Error(`secrets: bad kind ${kind}`);
        if (!B58.test(account)) throw new Error('secrets: the account is not a base58 address');
        return `${PREFIX}${kind}:${account}`;
    }
    /** True when this browser can keep a secret (localStorage readable and writable). */
    available(): boolean {
        if (!this.storage) return false;
        try { const k = `${PREFIX}probe`; this.storage.setItem(k, '1'); this.storage.removeItem(k); return true; } catch { return false; }
    }
    get(kind: SecretKind, account: string): SecretRecord | null {
        if (!this.storage) return null;
        let text: string | null = null;
        try { text = this.storage.getItem(this.name(kind, account)); } catch { return null; }
        if (!text) return null;
        try {
            const r = JSON.parse(text);
            return validRecord(r) && r.kind === kind && r.account === account ? r : null;
        } catch { return null; }
    }
    /**
     * The record of (kind, account): the stored one when it exists (a retry reuses the same bytes), otherwise a fresh one
     * from make(), written and read back BEFORE it is returned. Throws when the browser cannot keep it: no transaction may
     * commit to a secret that is not stored.
     */
    getOrCreate(kind: SecretKind, account: string, make: () => Record<string, unknown>): { record: SecretRecord; reused: boolean } {
        const prior = this.get(kind, account);
        if (prior) return { record: prior, reused: true };
        if (!this.storage) throw new Error('This browser cannot store the game secret (storage is blocked), so nothing was sent.');
        const rec = { kind, account, createdAt: new Date().toISOString(), ...make() };
        if (!validRecord(rec)) throw new Error('secrets: the new record is malformed, nothing was sent');
        try { this.storage.setItem(this.name(kind, account), JSON.stringify(rec)); } catch { /* checked below */ }
        const back = this.get(kind, account);
        if (!back || secretFields(back) !== secretFields(rec)) throw new Error('This browser did not keep the game secret (storage full or blocked), so nothing was sent.');
        return { record: back, reused: false };
    }
    /** Adds non-secret fields (e.g. the transaction signature) to an existing record. */
    annotate(kind: SecretKind, account: string, fields: Record<string, unknown>): void {
        const prior = this.get(kind, account);
        if (!prior || !this.storage) return;
        const next = { ...prior, ...fields, kind: prior.kind, account: prior.account };
        if (secretFields(next) !== secretFields(prior)) return; // secret bytes never change
        try { this.storage.setItem(this.name(kind, account), JSON.stringify(next)); } catch { /* the record without the note stays */ }
    }
    remove(kind: SecretKind, account: string): void {
        try { this.storage?.removeItem(this.name(kind, account)); } catch { /* storage blocked */ }
    }
    list(): SecretRecord[] {
        const out: SecretRecord[] = [];
        if (!this.storage) return out;
        try {
            for (let i = 0; i < this.storage.length; i++) {
                const k = this.storage.key(i);
                if (!k || !k.startsWith(PREFIX)) continue;
                const [kind, account] = k.slice(PREFIX.length).split(':') as [SecretKind, string];
                const r = SECRET_KINDS.includes(kind) ? this.get(kind, account) : null;
                if (r) out.push(r);
            }
        } catch { /* storage blocked */ }
        return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    /** The explicit backup: every record, as one JSON text the player saves (it holds secrets: keep it private). */
    exportSecrets(programId: string, now = new Date()): string {
        return JSON.stringify({ format: BACKUP_FORMAT, version: 1, programId, exportedAt: now.toISOString(), records: this.list() }, null, 1);
    }
    /**
     * Restores a backup made by exportSecrets (on this or another browser). A record already stored with the same bytes is
     * skipped; one stored with DIFFERENT bytes is never overwritten (reported as a conflict); malformed records are refused.
     */
    importSecrets(text: string, programId: string): { added: number; same: number; conflicts: string[]; refused: number } {
        let doc: any;
        try { doc = JSON.parse(text); } catch { throw new Error('This is not a Moon Forge secrets backup (not JSON).'); }
        if (doc?.format !== BACKUP_FORMAT || doc?.version !== 1 || !Array.isArray(doc?.records)) throw new Error('This is not a Moon Forge secrets backup.');
        if (doc.programId !== programId) throw new Error(`This backup is for another program (${String(doc.programId).slice(0, 12)}…).`);
        if (!this.storage) throw new Error('This browser cannot store secrets (storage is blocked).');
        const res = { added: 0, same: 0, conflicts: [] as string[], refused: 0 };
        for (const r of doc.records) {
            if (!validRecord(r)) { res.refused++; continue; }
            const prior = this.get(r.kind, r.account);
            if (prior) {
                if (secretFields(prior) === secretFields(r)) res.same++;
                else res.conflicts.push(`${r.kind} ${r.account}`);
                continue;
            }
            try { this.storage.setItem(this.name(r.kind, r.account), JSON.stringify(r)); res.added++; } catch { res.refused++; }
        }
        return res;
    }
}

/** The page's store (localStorage when the browser allows it). */
export function browserSecrets(): SecretsStore {
    try { return new SecretsStore(typeof window !== 'undefined' ? window.localStorage : null); } catch { return new SecretsStore(null); }
}

// ── phases: who acts, until when, and what happens if the other player stops ────────────────────────────────
const mins = (s: number) => (s % 60 === 0 ? `${s / 60} minutes` : `${s} seconds`);
const about = (s: number) => (s >= 3_600 ? `about ${Math.round(s / 3_600)} hour${Math.round(s / 3_600) === 1 ? '' : 's'}` : mins(s));

/** Plain texts of what happens when a player stops, from the program's timeout rules (p2p.rs, wars.rs). */
export const IF_STOPS = {
    duelOffer: `An offer can be joined for ${about(P2P_OFFER_TTL)}; until someone joins, the creator can cancel it for a full refund.`,
    duelJoiner: `After joining, the joiner must open its sealed element within ${mins(DUEL_JOIN_REVEAL_WINDOW)}. If it does not, anyone can close the duel: the creator gets its stake back and the joiner's stake goes to the burners' reward pool.`,
    duelCreator: `Once the joiner has opened, the creator must reveal within ${about(DUEL_REVEAL_WINDOW)}. If it does not, anyone can close the duel and the joiner receives the pot minus 2%.`,
    warOffer: `An offer can be joined for ${about(P2P_OFFER_TTL)}; until someone joins, the creator can cancel it for a full refund.`,
    warSeed: `After a join, the creator opens its entropy within ${mins(WAR_SEED_WINDOW)}. If it does not, the match is a draw: both stakes are refunded in full.`,
    warReveal: `Then the joiner opens its secret within ${mins(WAR_REVEAL_WINDOW)}. If it does not, the creator wins.`,
    warClock: `During the match each turn has ${WAR_TURN_FREE} free seconds, then draws on a ${WAR_TIME_BANK}-second bank per side; one turn never lasts more than ${WAR_TURN_TIMEOUT} seconds (the creator's first turn has ${mins(WAR_FIRST_TURN_GRACE)}, never charged). A player whose time runs out loses; anyone can claim it.`,
} as const;

export type DuelAction = 'cancel' | 'open' | 'reveal' | 'timeout' | null;
export interface DuelLike { creator: PublicKey; opponent: PublicKey; state: number; opponentElement: number; deadline: bigint | number | { toString(): string } }
export interface DuelPhase {
    /** 0 open, 1 joined (sealed), 2 joined (opened), 3 done */
    step: 'open' | 'expired-offer' | 'sealed' | 'opened' | 'done';
    deadline: number;
    /** what this wallet can do now */
    action: DuelAction;
    /** one line: what is awaited and what happens if it does not come */
    text: string;
}
export function duelPhase(d: DuelLike, me: PublicKey | null, now: number): DuelPhase {
    const deadline = Number(d.deadline.toString());
    const isCreator = !!me && d.creator.equals(me);
    const isOpponent = !!me && d.state >= 1 && d.opponent.equals(me);
    if (d.state === 0) {
        const expired = deadline !== 0 && now > deadline;
        return {
            step: expired ? 'expired-offer' : 'open', deadline, action: isCreator ? 'cancel' : null,
            text: expired ? 'This offer can no longer be joined; its creator can cancel it for a full refund.' : IF_STOPS.duelOffer,
        };
    }
    if (d.state === 1 && d.opponentElement === DUEL_ELEMENT_SEALED) {
        if (now > deadline) return { step: 'sealed', deadline, action: 'timeout', text: 'The joiner did not open in time: closing it refunds the creator and sends the joiner\'s stake to the reward pool.' };
        return { step: 'sealed', deadline, action: isOpponent ? 'open' : null, text: IF_STOPS.duelJoiner };
    }
    if (d.state === 1) {
        if (now > deadline) return { step: 'opened', deadline, action: 'timeout', text: 'The creator did not reveal in time: closing it pays the joiner the pot minus 2%.' };
        return { step: 'opened', deadline, action: isCreator ? 'reveal' : null, text: IF_STOPS.duelCreator };
    }
    return { step: 'done', deadline, action: null, text: 'Resolved.' };
}

export type WarStep = 'open' | 'expired-offer' | 'seed' | 'reveal' | 'active' | 'done' | 'legacy';
export interface WarLike { creator: PublicKey; opponent: PublicKey; state: number; turn: number; deadline: bigint | number | { toString(): string }; targetSlot: bigint | number | { toString(): string } }
export interface WarPhase {
    step: WarStep;
    deadline: number;
    /** 0 = creator, 1 = opponent: who is awaited (seed: creator, reveal: opponent, active: the mover) */
    awaited: 0 | 1 | null;
    /** this wallet is awaited now and still in time */
    myStep: boolean;
    /** anyone can close it on time now */
    timeout: boolean;
    text: string;
}
export function warPhase(w: WarLike, me: PublicKey | null, now: number): WarPhase {
    const deadline = Number(w.deadline.toString());
    const sealed = isSealedWar(BigInt(w.targetSlot.toString()));
    const meIdx = !me ? -1 : w.creator.equals(me) ? 0 : w.state >= 1 && w.opponent.equals(me) ? 1 : -1;
    const late = now > deadline;
    if (!sealed && w.state < 3) return { step: 'legacy', deadline, awaited: null, myStep: false, timeout: false, text: 'A match from before the final upgrade: it finishes under its own rules.' };
    if (w.state === 0) {
        const expired = late;
        return { step: expired ? 'expired-offer' : 'open', deadline, awaited: null, myStep: false, timeout: false, text: expired ? 'This offer can no longer be joined; its creator can cancel it for a full refund.' : IF_STOPS.warOffer };
    }
    if (w.state === 1) {
        const awaited = (w.turn === 0 ? 0 : 1) as 0 | 1;
        return {
            step: awaited === 0 ? 'seed' : 'reveal', deadline, awaited, myStep: meIdx === awaited && !late, timeout: late,
            text: awaited === 0
                ? (late ? 'The creator did not seed in time: closing it makes the match a draw (both refunded).' : IF_STOPS.warSeed)
                : (late ? 'The joiner did not reveal in time: closing it gives the creator the win.' : IF_STOPS.warReveal),
        };
    }
    if (w.state === 2) {
        const awaited = (w.turn === 0 ? 0 : 1) as 0 | 1;
        return { step: 'active', deadline, awaited, myStep: meIdx === awaited && !late, timeout: late, text: late ? 'The player to move ran out of time: closing it gives the other player the win.' : IF_STOPS.warClock };
    }
    return { step: 'done', deadline, awaited: null, myStep: false, timeout: false, text: 'Finished: anyone can pay it out (a draw refunds both in full).' };
}
