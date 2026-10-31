/**
 * The rules-3 transaction builders against the NEW IDL, offline (no RPC is ever called): every account name the site
 * passes exists in the instruction, the account order and writability are the IDL's, the data starts with the
 * instruction's discriminator. A re-synced IDL that renames or reorders an account fails here.
 */
import { describe, expect, it } from 'vitest';
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { parseV3Idl } from '../../src/v3/program';
import { claimExtraAccounts, extraLeafStatus, proofBytes, V3_PDA } from '../../src/v3/extra';
import { jackpotOffered, keeperSeatReady, newHouseBetsOffered } from '../../src/v3/keeper';
import { extraLeaf, hashPair, toHex } from '../../src/lib/verify-leaf';
import { KEEPER_BOND_MIN, V3_PDAS } from '../../src/v3/constants';
import { decodeHouseKeeper } from '../../src/v3/layout';
import fs from 'node:fs';
import path from 'node:path';

const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const text = fs.readFileSync(path.resolve(__dirname, '../../src/idl/moon_forge.v3.json'), 'utf8');
const offline = new Connection('http://127.0.0.1:1', 'confirmed'); // never contacted: .instruction() needs no RPC
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
    spec.forEach((a: any, i: number) => expect(ix.keys[i].isWritable, `${name}.${a.name} writable`).toBe(!!a.writable));
    expect(Buffer.from(ix.data.subarray(0, 8)).toString('hex')).toBe(Buffer.from(ixIdl(name).discriminator).toString('hex'));
    return spec;
}

describe('rules-3 builders encode against the new IDL', () => {
    it('the new IDL loads through the one module and is pinned to the program', async () => {
        const v = await parseV3Idl(text);
        expect(v.instructions).toBe(92);
        expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(v.errors.find((e) => e.code === 6066)?.name).toBe('ClaimOnHold');
        await expect(parseV3Idl(text.replace('57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9', '11111111111111111111111111111111'))).rejects.toThrow(/pinned/);
    });
    it('forge_artifact with extra_state + extra_vault appended', async () => {
        const p = await program();
        const buyer = Keypair.generate().publicKey; const architect = Keypair.generate().publicKey;
        const asset = V3_PDA.asset(2, 7);
        const ix = await p.methods.forgeArtifact(2, 7, new anchor.BN('63000000000')).accountsPartial({
            config: V3_PDA.config(), asset, record: V3_PDA.artifact(asset), collection: V3_PDA.collection(), artifactAuthority: V3_PDA.artifactAuthority(),
            rewardVault: V3_PDA.rewardVault(), drawVault: V3_PDA.drawVault(), architect, buyer, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
            extraState: V3_PDA.extraState(), extraVault: V3_PDA.extraVault(),
        }).instruction();
        const spec = checkLayout('forge_artifact', ix);
        expect(spec.slice(-2).map((a: any) => a.name)).toEqual(['extra_state', 'extra_vault']);
        expect(ix.keys[11].pubkey.toBase58()).toBe(V3_PDAS.extraState);
        expect(ix.keys[12].pubkey.toBase58()).toBe(V3_PDAS.extraVault);
        expect(ix.keys[7].pubkey.equals(architect)).toBe(true);
        expect(ix.data.length).toBe(8 + 1 + 4 + 8);
    });
    it('recycle_artifact with extra_state appended', async () => {
        const p = await program();
        const asset = Keypair.generate().publicKey;
        const ix = await p.methods.recycleArtifact().accountsPartial({
            config: V3_PDA.config(), asset, record: V3_PDA.artifact(asset), collection: V3_PDA.collection(), owner: Keypair.generate().publicKey, coreProgram: MPL_CORE,
            systemProgram: SystemProgram.programId, extraState: V3_PDA.extraState(),
        }).instruction();
        checkLayout('recycle_artifact', ix);
        expect(ix.keys[7].pubkey.toBase58()).toBe(V3_PDAS.extraState);
    });
    it('claim_extra', async () => {
        const p = await program();
        const w = Keypair.generate().publicKey;
        const ix = await p.methods.claimExtra(new anchor.BN(4), 3, new anchor.BN(1_000_000), proofBytes(['11'.repeat(32)])).accountsPartial(claimExtraAccounts(4, w, w)).instruction();
        checkLayout('claim_extra', ix);
        expect(ix.keys[2].pubkey.equals(V3_PDA.extraEpoch(4))).toBe(true);
        expect(ix.data.length).toBe(8 + 8 + 4 + 8 + 4 + 32);
    });
    it('market: list / update / delist / buy / close', async () => {
        const p = await program();
        const asset = Keypair.generate().publicKey; const seller = Keypair.generate().publicKey; const buyer = Keypair.generate().publicKey;
        const common = { config: V3_PDA.config(), listing: V3_PDA.listing(asset), asset, collection: V3_PDA.collection(), coreProgram: MPL_CORE, systemProgram: SystemProgram.programId };
        checkLayout('list_artifact', await p.methods.listArtifact(new anchor.BN(10), new anchor.BN(20), PublicKey.default, false).accountsPartial({ ...common, record: V3_PDA.artifact(asset), seller }).instruction());
        checkLayout('update_listing', await p.methods.updateListing(new anchor.BN(10), new anchor.BN(20), PublicKey.default).accountsPartial({ ...common, record: V3_PDA.artifact(asset), seller }).instruction());
        checkLayout('delist_artifact', await p.methods.delistArtifact().accountsPartial({ ...common, seller }).instruction());
        const buy = await p.methods.buyArtifact(new anchor.BN(10)).accountsPartial({ ...common, record: V3_PDA.artifact(asset), buyer, seller, architect: Keypair.generate().publicKey, rewardVault: V3_PDA.rewardVault() }).instruction();
        checkLayout('buy_artifact', buy);
        checkLayout('close_listing', await p.methods.closeListing().accountsPartial({ config: V3_PDA.config(), listing: V3_PDA.listing(asset), seller, asset, collection: V3_PDA.collection() }).instruction());
    });
});

describe('keeper gating and extra-leaf status', () => {
    const coder = new anchor.BorshAccountsCoder(JSON.parse(text));
    const seat = async (bond: bigint, keeper = Keypair.generate().publicKey) => decodeHouseKeeper(new Uint8Array(await coder.encode('HouseKeeper', {
        keeper, pending_keeper: PublicKey.default, pending_ts: new anchor.BN(0), tip: new Array(32).fill(0), length: new anchor.BN(0), next_index: new anchor.BN(0), revealed: new anchor.BN(0),
        bond: new anchor.BN(bond.toString()), pending_bets: 0, last_active_ts: new anchor.BN(0), armed_slot: new anchor.BN(0), week_start_ts: new anchor.BN(0), week_start_bankroll: new anchor.BN(0),
        week_net_loss: new anchor.BN(0), penalties: new anchor.BN(0), jackpot_reserved: new anchor.BN(0), withdraw_ts: new anchor.BN(0), bump: 255,
    })));
    it('Jackpot and house bets never before the announced SLA (F1-b); after it, only with a keeper and a bond of at least 20 XNT', async () => {
        // a decoded seat: before the service-level week nothing is offered, whatever the bond
        expect(jackpotOffered(null)).toBe(false);
        expect(jackpotOffered(await seat(KEEPER_BOND_MIN))).toBe(false);
        expect(jackpotOffered(await seat(KEEPER_BOND_MIN * 10n))).toBe(false);
        expect(newHouseBetsOffered(await seat(KEEPER_BOND_MIN * 10n))).toBe(false);
        // the seat check the later release relies on
        expect(keeperSeatReady(null)).toBe(false);
        expect(keeperSeatReady(await seat(KEEPER_BOND_MIN - 1n))).toBe(false);
        expect(keeperSeatReady(await seat(KEEPER_BOND_MIN))).toBe(true);
        expect(keeperSeatReady(await seat(KEEPER_BOND_MIN, PublicKey.default))).toBe(false);
        expect(jackpotOffered(await seat(KEEPER_BOND_MIN), true)).toBe(true);
        expect(jackpotOffered(await seat(KEEPER_BOND_MIN - 1n), true)).toBe(false);
        expect(jackpotOffered(await seat(KEEPER_BOND_MIN, PublicKey.default), true)).toBe(false);
    });
    it('an extra leaf is claimable only when the file root is the on-chain root and the proof walks to it', () => {
        const w = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
        const leaves = [{ index: 0, wallet: w[0], amount: '5000000' }, { index: 1, wallet: w[1], amount: '7000000' }];
        const l0 = extraLeaf(6, 0, w[0], 5_000_000n); const l1 = extraLeaf(6, 1, w[1], 7_000_000n);
        const root = toHex(hashPair(l0, l1));
        const file = { epoch: 6, root, leaves, proofs: { [w[0]]: [toHex(l1)], [w[1]]: [toHex(l0)] } };
        const bitmap = new Uint8Array(125);
        const onChain = { id: 6n, root, dataHash: '', budget: 12_000_000n, claimed: 0n, leaves: 2, publishedAt: 1_000_000n, freeBefore: 0n, closed: false, bump: 255, rentPayer: PublicKey.default, bitmap };
        expect(extraLeafStatus(file, onChain, w[0], 1_000_000 + 100)?.status).toBe('on-hold');
        expect(extraLeafStatus(file, onChain, w[0], 1_000_000 + 172_800)?.status).toBe('claimable');
        expect(extraLeafStatus(file, { ...onChain, root: '00'.repeat(32) }, w[0], 2_000_000)?.status).toBe('mismatch');
        expect(extraLeafStatus({ ...file, proofs: { [w[0]]: [] } }, onChain, w[0], 2_000_000)?.status).toBe('mismatch');
        bitmap[0] = 1;
        expect(extraLeafStatus(file, onChain, w[0], 2_000_000)?.status).toBe('claimed');
        expect(extraLeafStatus(file, { ...onChain, closed: true }, w[1], 2_000_000)?.status).toBe('closed');
        expect(extraLeafStatus(file, null, w[1], 2_000_000)?.status).toBe('not-published');
        expect(extraLeafStatus(file, onChain, Keypair.generate().publicKey.toBase58(), 2_000_000)).toBeNull();
    });
});
