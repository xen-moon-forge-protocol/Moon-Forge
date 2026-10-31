import { describe, expect, it } from 'vitest';
import * as anchor from '@coral-xyz/anchor';
import { Keypair, PublicKey } from '@solana/web3.js';
import idlV3 from '../../src/idl/moon_forge.v3.json';
import idlLive from '../../src/idl/moon_forge.json';
import { accountFilters, decodeExtraEpoch, decodeExtraState, decodeHouseKeeper, decodeListing, hasLayout, hex, leafClaimed, V3_ACCOUNTS } from '../../src/v3/layout';
import { extraBound } from '../../src/v3/extra';
import fs from 'node:fs';
import path from 'node:path';

const coder = new anchor.BorshAccountsCoder(idlV3 as anchor.Idl);
const BN = anchor.BN;
const key = () => Keypair.generate().publicKey;
const enc = async (name: string, v: any) => new Uint8Array(await coder.encode(name, v));

describe('rules-3 account layouts match the new IDL', () => {
    it('discriminators and sizes are the IDL ones, and none exists in the live IDL', () => {
        for (const [name, L] of Object.entries(V3_ACCOUNTS)) {
            const a = (idlV3 as any).accounts.find((x: any) => x.name === name);
            expect(a, name).toBeTruthy();
            expect(hex(Uint8Array.from(a.discriminator))).toBe(L.disc);
            expect(coder.size(name), name).toBe(L.size);
            expect((idlLive as any).accounts.find((x: any) => x.name === name), `${name} must be new`).toBeUndefined();
        }
    });

    it('ExtraState decodes field by field', async () => {
        const v = {
            last_epoch: new BN(7), last_publish_ts: new BN(1_795_000_123), accounted: new BN('123456789012'), reserved: new BN(42), free_after: new BN(99),
            live_forged_backing: new BN('5000000000'), out_since_publish: new BN(3), total_in: new BN('987654321'), total_paid: new BN(11), total_returned: new BN(12),
            vault_bump: 255, bump: 254,
        };
        const d = decodeExtraState(await enc('ExtraState', v))!;
        expect(d).toBeTruthy();
        expect(d.lastEpoch).toBe(7n);
        expect(d.lastPublishTs).toBe(1_795_000_123n);
        expect(d.accounted).toBe(123456789012n);
        expect(d.reserved).toBe(42n);
        expect(d.freeAfter).toBe(99n);
        expect(d.liveForgedBacking).toBe(5_000_000_000n);
        expect(d.outSincePublish).toBe(3n);
        expect(d.totalIn).toBe(987654321n);
        expect(d.totalPaid).toBe(11n);
        expect(d.totalReturned).toBe(12n);
        expect([d.vaultBump, d.bump]).toEqual([255, 254]);
    });

    it('ExtraEpoch decodes, including the claim bitmap', async () => {
        const bitmap = new Array(125).fill(0);
        bitmap[0] = 0b0000_0101; // leaves 0 and 2
        bitmap[124] = 0x80; // leaf 999
        const rp = key();
        const v = {
            id: new BN(9), root: new Array(32).fill(0).map((_, i) => i), data_hash: new Array(32).fill(7), budget: new BN(1000), claimed: new BN(10), leaves: 1000,
            published_at: new BN(1_795_478_400), free_before: new BN(5), closed: true, bump: 253, rent_payer: rp, bitmap,
        };
        const d = decodeExtraEpoch(await enc('ExtraEpoch', v))!;
        expect(d.id).toBe(9n);
        expect(d.root).toBe(hex(Uint8Array.from(v.root)));
        expect(d.dataHash).toBe('07'.repeat(32));
        expect([d.budget, d.claimed, d.leaves, d.publishedAt, d.freeBefore, d.closed, d.bump]).toEqual([1000n, 10n, 1000, 1_795_478_400n, 5n, true, 253]);
        expect(d.rentPayer.equals(rp)).toBe(true);
        expect([0, 1, 2, 3, 998, 999].map((i) => leafClaimed(d.bitmap, i))).toEqual([true, false, true, false, false, true]);
        expect(leafClaimed(d.bitmap, 1000)).toBe(false);
    });

    it('HouseKeeper decodes (bond at @136)', async () => {
        const k = key(); const pk = key();
        const v = {
            keeper: k, pending_keeper: pk, pending_ts: new BN(-5), tip: new Array(32).fill(9), length: new BN(100), next_index: new BN(4), revealed: new BN(3),
            bond: new BN('20000000000'), pending_bets: 2, last_active_ts: new BN(1_795_000_000), armed_slot: new BN(123), week_start_ts: new BN(1), week_start_bankroll: new BN(2),
            week_net_loss: new BN(-77), penalties: new BN(8), jackpot_reserved: new BN(6), withdraw_ts: new BN(0), bump: 255,
        };
        const d = decodeHouseKeeper(await enc('HouseKeeper', v))!;
        expect(d.keeper.equals(k) && d.pendingKeeper.equals(pk)).toBe(true);
        expect([d.pendingTs, d.length, d.nextIndex, d.revealed, d.bond, d.pendingBets, d.lastActiveTs, d.armedSlot]).toEqual([-5n, 100n, 4n, 3n, 20_000_000_000n, 2, 1_795_000_000n, 123n]);
        expect([d.weekStartTs, d.weekStartBankroll, d.weekNetLoss, d.penalties, d.jackpotReserved, d.withdrawTs, d.bump]).toEqual([1n, 2n, -77n, 8n, 6n, 0n, 255]);
        expect(d.tip).toBe('09'.repeat(32));
    });

    it('Listing decodes', async () => {
        const a = key(); const s = key();
        const v = { asset: a, seller: s, reserved_buyer: PublicKey.default, price: new BN('12345000000'), created_at: new BN(10), expires_at: new BN(20), tier: 3, bump: 251 };
        const d = decodeListing(await enc('Listing', v))!;
        expect(d.asset.equals(a) && d.seller.equals(s) && d.reservedBuyer.equals(PublicKey.default)).toBe(true);
        expect([d.price, d.createdAt, d.expiresAt, d.tier, d.bump]).toEqual([12_345_000_000n, 10n, 20n, 3, 251]);
    });

    it('the market gPA filter is the IDL Listing discriminator and size, and fetchListings uses it', async () => {
        const a = (idlV3 as any).accounts.find((x: any) => x.name === 'Listing');
        const [size, memcmp] = accountFilters('Listing', (b) => anchor.utils.bytes.bs58.encode(b));
        expect(size.dataSize).toBe(coder.size('Listing'));
        expect(memcmp.memcmp.offset).toBe(0);
        expect(memcmp.memcmp.bytes).toBe(anchor.utils.bytes.bs58.encode(Uint8Array.from(a.discriminator)));
        // an encoded Listing passes both filters
        const data = await enc('Listing', { asset: key(), seller: key(), reserved_buyer: key(), price: new BN(1), created_at: new BN(1), expires_at: new BN(2), tier: 0, bump: 1 });
        expect(data.length).toBe(size.dataSize);
        expect(anchor.utils.bytes.bs58.encode(data.subarray(0, 8))).toBe(memcmp.memcmp.bytes);
        // no hand-written discriminator or size left in the market reads
        const src = fs.readFileSync(path.resolve(__dirname, '../../src/v3/actions.ts'), 'utf8');
        expect(src).toContain("accountFilters('Listing'");
        expect(src).not.toMatch(/dataSize:\s*\d/);
    });

    it('the extra-epoch cap mirrors extra.rs extra_bound (backing = live + out since publish, per week, up to 13 weeks)', () => {
        const x = {
            lastEpoch: 0n, lastPublishTs: 0n, accounted: 1_000_000_000_000n, reserved: 100_000_000_000n, freeAfter: 0n,
            liveForgedBacking: 500_000_000_000n, outSincePublish: 50_000_000_000n, totalIn: 0n, totalPaid: 0n, totalReturned: 0n, vaultBump: 0, bump: 0,
        };
        const b1 = extraBound(x, 1)!;
        expect(b1.free).toBe(900_000_000_000n);
        expect(b1.releaseCap).toBe(72_000_000_000n); // 8% of free
        expect(b1.perWeek).toBe(22_000_000_000n); // 4% of (500 + 50)
        expect(b1.cap).toBe(22_000_000_000n);
        expect(extraBound(x, 3)!.cap).toBe(66_000_000_000n);
        expect(extraBound(x, 13)!.cap).toBe(72_000_000_000n); // the release term binds
        expect(extraBound(x, 40)!.cap).toBe(extraBound(x, 13)!.cap); // clamped to EXTRA_MAX_WEEKS
        expect(extraBound(x, 0)!.cap).toBe(b1.cap); // at least one week
        expect(extraBound({ ...x, reserved: x.accounted + 1n }, 1)).toBeNull();
        expect(extraBound({ ...x, liveForgedBacking: 1n, outSincePublish: 0n }, 1)!.cap).toBe(0n); // floored like bps()
    });

    it('refuses wrong discriminators and sizes', async () => {
        const good = await enc('Listing', { asset: key(), seller: key(), reserved_buyer: key(), price: new BN(1), created_at: new BN(1), expires_at: new BN(2), tier: 0, bump: 1 });
        expect(hasLayout('Listing', good)).toBe(true);
        expect(decodeExtraState(good)).toBeNull();
        expect(decodeListing(good.slice(0, 129))).toBeNull();
        const bad = good.slice(); bad[0] ^= 1;
        expect(decodeListing(bad)).toBeNull();
        expect(decodeListing(null as any)).toBeNull();
    });
});
