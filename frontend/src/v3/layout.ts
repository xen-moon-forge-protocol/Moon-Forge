/**
 * Byte layouts of the accounts that only the upgraded program creates (programs/moon-forge/src/state.rs, rules 3).
 *
 * Decoded by hand (fixed offsets, little-endian) so that rules detection and the read-only views need neither the new
 * IDL nor Anchor: a few hundred bytes of code that load with the page. test/v3/layout.test.ts encodes every account
 * with Anchor's coder from src/idl/moon_forge.v3.json and checks these decoders field by field, so a layout change in
 * the program (a re-synced IDL) fails the tests instead of being misread on the site.
 *
 * Pure: no React, no network.
 */
import { PublicKey } from '@solana/web3.js';

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from(h.match(/.{2}/g) ?? [], (x) => parseInt(x, 16));

/** Anchor account discriminators (sha256("account:<Name>")[..8]) and sizes, copied from the new IDL and state.rs. */
export const V3_ACCOUNTS = {
    ExtraState: { disc: 'ee1f1b1bec696daa', size: 90 },
    ExtraEpoch: { disc: '22c8264cc3930863', size: 275 },
    HouseKeeper: { disc: '00b138e7b7a5538e', size: 213 },
    Listing: { disc: 'da2032492b861a3a', size: 130 },
    OracleSeat: { disc: '23df920b26094fb8', size: 157 },
} as const;
export type V3AccountName = keyof typeof V3_ACCOUNTS;

class Reader {
    private dv: DataView;
    constructor(private data: Uint8Array) {
        this.dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    }
    u8 = (o: number) => this.dv.getUint8(o);
    u32 = (o: number) => this.dv.getUint32(o, true);
    u64 = (o: number) => this.dv.getBigUint64(o, true);
    i64 = (o: number) => this.dv.getBigInt64(o, true);
    key = (o: number) => new PublicKey(this.data.subarray(o, o + 32));
    bytes = (o: number, n: number) => this.data.slice(o, o + n);
}

/** True when `data` starts with the discriminator of `name` and has exactly its size. */
export function hasLayout(name: V3AccountName, data: Uint8Array | null | undefined): data is Uint8Array {
    const L = V3_ACCOUNTS[name];
    if (!data || data.length !== L.size) return false;
    const d = fromHex(L.disc);
    for (let i = 0; i < 8; i++) if (data[i] !== d[i]) return false;
    return true;
}

/**
 * getProgramAccounts filters that select every account of `name`: its exact size and its discriminator at offset 0,
 * both from V3_ACCOUNTS (so an IDL re-sync changes them here, and test/v3/layout.test.ts checks them against the IDL).
 * `bs58` encodes the discriminator (anchor.utils.bytes.bs58.encode at the call site; this module stays Anchor-free).
 */
export function accountFilters(name: V3AccountName, bs58: (b: Uint8Array) => string): [{ dataSize: number }, { memcmp: { offset: number; bytes: string } }] {
    const L = V3_ACCOUNTS[name];
    return [{ dataSize: L.size }, { memcmp: { offset: 0, bytes: bs58(fromHex(L.disc)) } }];
}

/** ExtraState ["extra_state"]: the extra pot as the program counts it (counters, never lamport reads). */
export interface ExtraStateView {
    lastEpoch: bigint;
    lastPublishTs: bigint;
    /** forge inflows + returned − paid: the pot as the program knows it */
    accounted: bigint;
    /** Σ (budget − claimed) of the open extra epochs */
    reserved: bigint;
    /** accounted − reserved right after the last extra publication */
    freeAfter: bigint;
    liveForgedBacking: bigint;
    outSincePublish: bigint;
    totalIn: bigint;
    totalPaid: bigint;
    totalReturned: bigint;
    vaultBump: number;
    bump: number;
}
export function decodeExtraState(data: Uint8Array): ExtraStateView | null {
    if (!hasLayout('ExtraState', data)) return null;
    const r = new Reader(data);
    return {
        lastEpoch: r.u64(8), lastPublishTs: r.i64(16), accounted: r.u64(24), reserved: r.u64(32), freeAfter: r.u64(40),
        liveForgedBacking: r.u64(48), outSincePublish: r.u64(56), totalIn: r.u64(64), totalPaid: r.u64(72), totalReturned: r.u64(80),
        vaultBump: r.u8(88), bump: r.u8(89),
    };
}

/** ExtraEpoch ["extra_epoch", id]: one published extra epoch; claims are bits of `bitmap`. */
export interface ExtraEpochView {
    id: bigint;
    root: string;
    dataHash: string;
    budget: bigint;
    claimed: bigint;
    leaves: number;
    publishedAt: bigint;
    freeBefore: bigint;
    closed: boolean;
    bump: number;
    rentPayer: PublicKey;
    bitmap: Uint8Array;
}
export function decodeExtraEpoch(data: Uint8Array): ExtraEpochView | null {
    if (!hasLayout('ExtraEpoch', data)) return null;
    const r = new Reader(data);
    return {
        id: r.u64(8), root: hex(r.bytes(16, 32)), dataHash: hex(r.bytes(48, 32)), budget: r.u64(80), claimed: r.u64(88), leaves: r.u32(96),
        publishedAt: r.i64(100), freeBefore: r.u64(108), closed: r.u8(116) !== 0, bump: r.u8(117), rentPayer: r.key(118), bitmap: r.bytes(150, 125),
    };
}
/** Bit i of the claim bitmap = leaf i claimed. */
export const leafClaimed = (bitmap: Uint8Array, index: number) => index >= 0 && index < bitmap.length * 8 && ((bitmap[index >> 3] >> (index & 7)) & 1) === 1;

/** HouseKeeper ["house_keeper"]: the hash-chain keeper seat of house games and the Jackpot. */
export interface HouseKeeperView {
    keeper: PublicKey;
    pendingKeeper: PublicKey;
    pendingTs: bigint;
    tip: string;
    length: bigint;
    nextIndex: bigint;
    revealed: bigint;
    /** lamports above rent */
    bond: bigint;
    pendingBets: number;
    lastActiveTs: bigint;
    armedSlot: bigint;
    weekStartTs: bigint;
    weekStartBankroll: bigint;
    weekNetLoss: bigint;
    penalties: bigint;
    jackpotReserved: bigint;
    withdrawTs: bigint;
    bump: number;
}
export function decodeHouseKeeper(data: Uint8Array): HouseKeeperView | null {
    if (!hasLayout('HouseKeeper', data)) return null;
    const r = new Reader(data);
    return {
        keeper: r.key(8), pendingKeeper: r.key(40), pendingTs: r.i64(72), tip: hex(r.bytes(80, 32)), length: r.u64(112), nextIndex: r.u64(120),
        revealed: r.u64(128), bond: r.u64(136), pendingBets: r.u32(144), lastActiveTs: r.i64(148), armedSlot: r.u64(156), weekStartTs: r.i64(164),
        weekStartBankroll: r.u64(172), weekNetLoss: r.i64(180), penalties: r.u64(188), jackpotReserved: r.u64(196), withdrawTs: r.i64(204), bump: r.u8(212),
    };
}

/** Listing ["listing", asset]: an escrowless native sale (the asset stays in the seller's wallet, delegated to the listing). */
export interface ListingView {
    asset: PublicKey;
    seller: PublicKey;
    /** PublicKey.default = anyone may buy */
    reservedBuyer: PublicKey;
    price: bigint;
    createdAt: bigint;
    expiresAt: bigint;
    tier: number;
    bump: number;
}
export function decodeListing(data: Uint8Array): ListingView | null {
    if (!hasLayout('Listing', data)) return null;
    const r = new Reader(data);
    return {
        asset: r.key(8), seller: r.key(40), reservedBuyer: r.key(72), price: r.u64(104), createdAt: r.i64(112), expiresAt: r.i64(120), tier: r.u8(128), bump: r.u8(129),
    };
}
