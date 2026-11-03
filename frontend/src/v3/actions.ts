/**
 * Rules-3 transactions (upgraded program only; every caller checks rules detection = 3 first).
 *
 * Built with the new IDL through src/v3/program.ts and sent with a measured compute-unit limit (lib/cu.ts withCu: the
 * exact transaction is simulated; after the upgrade the old static table is never applied). The architect account is
 * read from Config (config.architect: the architect payee, which set_architect can rotate), never the hard-coded live wallet.
 */
import * as anchor from '@coral-xyz/anchor';
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { withCu } from '../lib/cu';
import { MPL_CORE, readConnection, type X1Provider } from '../lib/protocol';
import { getProgramV3 } from './program';
import { claimExtraAccounts, proofBytes, V3_PDA, type MyExtraLeaf } from './extra';
import { currentPrice } from './px';
import { MARKET_MAX_LISTING_SECONDS, MARKET_MIN_PRICE } from './constants';
import { accountFilters, decodeListing, type ListingView } from './layout';
import { PROGRAM_PK } from './detect';
import { marketSplit } from './market';
import { coreClosedOrFalse, recycleRemainingAccounts } from './core-hatch';

const bn = (n: number | bigint | string) => new anchor.BN(n.toString());
const me = (p: X1Provider) => new PublicKey(p.publicKey.toString());
const send = (p: X1Provider, name: string, builder: any) => withCu(builder, name, me(p), readConnection);

async function config(program: anchor.Program) {
    return (program.account as any).config.fetch(V3_PDA.config());
}

/** forge_artifact under rules 3: PX price (max price signed = the price shown), the two-pot split, extra_state + extra_vault appended. */
export async function forgeArtifactV3(p: X1Provider, tier: number, shownPrice: bigint) {
    const program = await getProgramV3(p, readConnection);
    const cfg = await config(program);
    const now = Math.floor(Date.now() / 1000);
    const price = currentPrice(cfg, tier, now);
    // Re-quote before signing: never sign a max price above what the page showed.
    if (price > shownPrice) throw new Error(`The forge price moved to ${Number(price) / 1e9} XNT since it was shown. Check the new price and confirm again.`);
    const serial = Number(cfg.artifactsMinted[tier]);
    const asset = V3_PDA.asset(tier, serial);
    return send(p, `forge_artifact:t${tier}`, program.methods.forgeArtifact(tier, serial, bn(shownPrice)).accountsPartial({
        config: V3_PDA.config(), asset, record: V3_PDA.artifact(asset), collection: V3_PDA.collection(), artifactAuthority: V3_PDA.artifactAuthority(),
        rewardVault: V3_PDA.rewardVault(), drawVault: V3_PDA.drawVault(), architect: cfg.architect, buyer: me(p), coreProgram: MPL_CORE,
        systemProgram: SystemProgram.programId, extraState: V3_PDA.extraState(), extraVault: V3_PDA.extraVault(),
    }));
}

/**
 * recycle_artifact under rules 3 (extra_state appended): the floor comes back, the slot is freed. r9 hatch: when Metaplex
 * Core is closed on X1 (src/v3/core-hatch.ts), Core's ProgramData is passed as the one remaining account and the program
 * pays the floor without the burn; otherwise no remaining account (the normal path). Pure: every account explicit.
 */
export function buildRecycleArtifactV3(program: anchor.Program, owner: PublicKey, asset: PublicKey, coreClosed: boolean) {
    return program.methods.recycleArtifact().accountsPartial({
        config: V3_PDA.config(), asset, record: V3_PDA.artifact(asset), collection: V3_PDA.collection(), owner, coreProgram: MPL_CORE,
        systemProgram: SystemProgram.programId, extraState: V3_PDA.extraState(),
    }).remainingAccounts(recycleRemainingAccounts(coreClosed));
}
export async function recycleArtifactV3(p: X1Provider, asset: PublicKey) {
    const program = await getProgramV3(p, readConnection);
    // a failed read keeps the normal path (no remaining account), never a guess
    const closed = await coreClosedOrFalse(readConnection);
    return send(p, 'recycle_artifact', buildRecycleArtifactV3(program, me(p), asset, closed));
}

/** claim_extra: one verified extra leaf (src/v3/extra.ts refuses anything not verified against the on-chain root). */
export async function claimExtraV3(p: X1Provider, leaf: MyExtraLeaf) {
    if (leaf.status !== 'claimable' || !leaf.verified) throw new Error('This extra leaf is not claimable (not verified, on hold, claimed or closed).');
    const program = await getProgramV3(p, readConnection);
    const wallet = me(p);
    return send(p, 'claim_extra', program.methods.claimExtra(bn(leaf.epoch), leaf.index, bn(leaf.amount), proofBytes(leaf.proof)).accountsPartial(claimExtraAccounts(leaf.epoch, wallet, wallet)));
}

// ── native market (escrowless; the asset stays in the seller's wallet) ─────────────────────────────────────

/** Every listing of the collection (gPA by the Listing discriminator + size, both from src/v3/layout.ts V3_ACCOUNTS). */
export async function fetchListings(connection: Connection = readConnection): Promise<{ pubkey: PublicKey; listing: ListingView }[]> {
    const accs = await connection.getProgramAccounts(PROGRAM_PK, {
        filters: accountFilters('Listing', (b) => anchor.utils.bytes.bs58.encode(b)),
    });
    return accs
        .map((a) => ({ pubkey: a.pubkey, listing: decodeListing(new Uint8Array(a.account.data)) }))
        .filter((x): x is { pubkey: PublicKey; listing: ListingView } => !!x.listing);
}

/** Checks a listing before signing, with the program's own rules (market.rs check_price / check_expiry). */
export function validateListing(price: bigint, backing: bigint, expiresAt: number, now: number): string | null {
    if (price < MARKET_MIN_PRICE) return `The smallest list price is ${Number(MARKET_MIN_PRICE) / 1e9} XNT.`;
    const { sellerNet } = marketSplit(price);
    if (sellerNet < backing) return 'After the 5% royalty and the 2% base-pot fee you would receive less than this Artifact’s floor: recycle it instead (it returns the whole floor).';
    if (!(expiresAt > now && expiresAt <= now + MARKET_MAX_LISTING_SECONDS)) return 'A listing must expire in the future and at most 90 days from now.';
    return null;
}

export async function listArtifactV3(p: X1Provider, asset: PublicKey, price: bigint, expiresAt: number, reservedBuyer: PublicKey | null) {
    const program = await getProgramV3(p, readConnection);
    const accounts = {
        config: V3_PDA.config(), listing: V3_PDA.listing(asset), asset, record: V3_PDA.artifact(asset), collection: V3_PDA.collection(),
        seller: me(p), coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
    };
    const buyer = reservedBuyer ?? PublicKey.default;
    try {
        return await send(p, 'list_artifact', program.methods.listArtifact(bn(price), bn(expiresAt), buyer, false).accountsPartial(accounts));
    } catch (e: any) {
        // an Artifact minted before the upgrade (or whose owner removed the plugin) needs the TransferDelegate plugin added
        if (!/PluginNotFound|plugin/i.test(String(e?.message ?? e) + JSON.stringify(e?.logs ?? []))) throw e;
        return send(p, 'list_artifact', program.methods.listArtifact(bn(price), bn(expiresAt), buyer, true).accountsPartial(accounts));
    }
}

export async function updateListingV3(p: X1Provider, asset: PublicKey, price: bigint, expiresAt: number, reservedBuyer: PublicKey | null) {
    const program = await getProgramV3(p, readConnection);
    return send(p, 'update_listing', program.methods.updateListing(bn(price), bn(expiresAt), reservedBuyer ?? PublicKey.default).accountsPartial({
        config: V3_PDA.config(), listing: V3_PDA.listing(asset), asset, record: V3_PDA.artifact(asset), collection: V3_PDA.collection(),
        seller: me(p), coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
    }));
}

export async function delistArtifactV3(p: X1Provider, asset: PublicKey) {
    const program = await getProgramV3(p, readConnection);
    return send(p, 'delist_artifact', program.methods.delistArtifact().accountsPartial({
        config: V3_PDA.config(), listing: V3_PDA.listing(asset), asset, collection: V3_PDA.collection(), seller: me(p), coreProgram: MPL_CORE,
        systemProgram: SystemProgram.programId,
    }));
}

/** buy_artifact at exactly the listed price (the program refuses ListingPriceChanged if the seller changed it). */
export async function buyArtifactV3(p: X1Provider, l: ListingView) {
    const program = await getProgramV3(p, readConnection);
    const fresh = await readConnection.getAccountInfo(V3_PDA.listing(l.asset));
    const now = decodeListing(fresh ? new Uint8Array(fresh.data) : new Uint8Array());
    if (!now) throw new Error('This listing no longer exists.');
    if (now.price !== l.price) throw new Error(`The seller changed the price to ${Number(now.price) / 1e9} XNT. Check it and confirm again.`);
    const cfg = await config(program);
    return send(p, 'buy_artifact', program.methods.buyArtifact(bn(l.price)).accountsPartial({
        config: V3_PDA.config(), listing: V3_PDA.listing(l.asset), asset: l.asset, record: V3_PDA.artifact(l.asset), collection: V3_PDA.collection(),
        buyer: me(p), seller: l.seller, architect: cfg.architect, rewardVault: V3_PDA.rewardVault(), coreProgram: MPL_CORE,
        systemProgram: SystemProgram.programId,
    }));
}

/** PERMISSIONLESS: closes an expired or stale listing (rent back to the seller). */
export async function closeListingV3(p: X1Provider, l: ListingView) {
    const program = await getProgramV3(p, readConnection);
    return send(p, 'close_listing', program.methods.closeListing().accountsPartial({
        config: V3_PDA.config(), listing: V3_PDA.listing(l.asset), seller: l.seller, asset: l.asset, collection: V3_PDA.collection(),
    }));
}
