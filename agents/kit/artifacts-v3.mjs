/**
 * Artifacts after the final upgrade (rules 3), for an agent with its own key: the forge price (PX mirror), forge at
 * any tier with a maximum price, what an Artifact is and whether it is genuine, its transfer (a Metaplex Core
 * transfer), the native market (list, update, delist, buy, close a stale listing) and the extra-pot rebate claims.
 * Installed on MoonForge by moonforge.mjs. Every Moon Forge instruction here exists only in the upgraded program, so
 * each method first checks that it is live (requireV3) and refuses cleanly before it; transferArtifact() is a Core
 * transfer and works under both rules.
 *
 * The extra pot (after the final upgrade; paid by the v3 oracle from its first epoch): each week it can pay a forged
 * Artifact's holder a rebate tied to the holder's own burns, only in a week in which the holder burned XEN that the base
 * pot did not fully pay, counting only burns whose X1 destination is the wallet that holds the Artifact; counted use is at
 * most 1% of the price paid per eligible Artifact per week, and the rebate at most 2 XNT per counted XNT, so at most 2% of
 * the price paid per Artifact per week; only in the first 52 weeks after the forge; while the pot lasts; a holder who does
 * not burn receives nothing from it. Artifacts never change a burn's
 * base payout. Market sales: 5% to the architect, 2% to the base reward pot, the rest to the seller, never below the
 * Artifact's floor.
 */
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { currentPrice, forgeSplit, listingPriceProblem, marketSplit, minimumListPrice, parseCoreAsset, V3 } from './rules-v3.mjs';
import { compareWithChain, extraLeafOf, verifyExtraFileOffline, verifyProof } from './verify-leaf.mjs';
import { checkX1Destination, inspectX1Destination } from './burn.mjs';
import { accountFieldOffset } from './idl.mjs';

const toPk = (x) => (x instanceof PublicKey ? x : new PublicKey(x));
const hex = (b) => Buffer.from(b).toString('hex');
const TIERS = ['Lunar Dust', 'Cosmic Shard', 'Solar Core', 'Void Anomaly'];
const ORIGINS = ['forged', 'genesis', 'drop'];
const DAY = 86_400;

/** A minimal methods-builder for a raw instruction (send() adds the compute-unit limit with preInstructions). */
function rawBuilder(ix) {
  return {
    pre: [],
    preInstructions(ixs) { this.pre.push(...ixs); return this; },
    async transaction() { const tx = new Transaction(); tx.add(...this.pre, ix); return tx; },
  };
}

export function installArtifactsV3(Cls, { anchor, PDA, XNT, MPL_CORE, coreOwner }) {
  const bn = (n) => new anchor.BN(n.toString());
  const lamports = (xnt) => BigInt(Math.round(Number(xnt) * XNT));
  const methods = {
    /** The forge price of `tier` now (rules 3: PX, a pure mirror of artifacts.rs current_price), in lamports and XNT. */
    async forgePrice(tier) {
      await this.requireV3('forgePrice');
      const [cfg, now] = await Promise.all([this.config(), this.chainTime()]);
      const price = currentPrice(cfg, tier, now);
      return { tier: Number(tier), name: TIERS[Number(tier)], lamports: price, xnt: Number(price) / XNT, split: forgeSplit(price), alive: Number(cfg.artifactsAlive[tier]), supply: V3.ARTIFACT_SUPPLY[tier] };
    },
    /**
     * Forges an Artifact of `tier` (0 Lunar Dust .. 3 Void Anomaly) at the current PX price, never above `maxPriceXnt`
     * (default: the price read now, so a forge that lands after someone else's fails instead of paying more). 50% of the
     * price stays inside as the floor you get back by recycling. Returns { asset, signature, price }.
     */
    async forge(tier, { maxPriceXnt } = {}) {
      this.warn('forge');
      await this.requireV3('forge', 'init_extra');
      const t = Number(tier);
      if (!(t >= 0 && t < 4)) throw new Error('forge: tier is 0 (Lunar Dust), 1 (Cosmic Shard), 2 (Solar Core) or 3 (Void Anomaly)');
      if (!(await this.connection.getAccountInfo(PDA.extraState()))) throw new Error('forge: the extra pot is not initialised yet (init_extra runs first at the upgrade); nothing was sent');
      const [cfg0, now] = await Promise.all([this.config(), this.chainTime()]);
      if (Number(cfg0.artifactsAlive[t]) >= V3.ARTIFACT_SUPPLY[t]) throw new Error(`forge: ${TIERS[t]} is sold out (SoldOut): wait for a recycle. Nothing was sent.`);
      const price = currentPrice(cfg0, t, now);
      const max = maxPriceXnt === undefined ? price : lamports(maxPriceXnt);
      if (price > max) throw new Error(`forge: the ${TIERS[t]} price is ${Number(price) / XNT} XNT, above your maximum ${Number(max) / XNT} XNT (SlippageExceeded). Nothing was sent.`);
      const build = async () => {
        const cfg = await this.config();
        const serial = cfg.artifactsMinted[t];
        const asset = PDA.asset(t, serial);
        const b = this.program.methods.forgeArtifact(t, serial, bn(max)).accountsPartial({
          config: PDA.config(), asset, record: PDA.artifact(asset), collection: PDA.collection(), artifactAuthority: PDA.artifactAuthority(),
          rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: cfg.architect, buyer: this.me, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
          extraState: PDA.extraState(), extraVault: PDA.extraVault(),
        });
        b.__asset = asset;
        return b;
      };
      let b = await build();
      const need = max + BigInt(await this.rentFor('artifactRecord')) + BigInt(await this.connection.getMinimumBalanceForRentExemption(400));
      const signature = await this.send(b, 'forgeArtifact', { needLamports: need, rebuild: async () => (b = await build()) });
      return { asset: b.__asset, signature, price };
    },

    /**
     * Whether `asset` is a genuine Moon Forge Artifact: a live Core AssetV1 of the Moon Forge collection, minted at the
     * program's asset address for its tier and serial, with its ArtifactRecord. Returns { genuine, reasons[], owner, record }.
     */
    async isGenuineArtifact(asset) {
      const pk = toPk(asset);
      const reasons = [];
      const [info, record] = await Promise.all([this.connection.getAccountInfo(pk, 'confirmed'), this.acc.artifactRecord.fetchNullable(PDA.artifact(pk))]);
      const owner = coreOwner(info);
      if (!info) reasons.push('no such account (never minted, or burned)');
      else if (!info.owner.equals(MPL_CORE)) reasons.push(`the account is owned by ${info.owner.toBase58()}, not Metaplex Core`);
      else if (!owner) reasons.push('not a live asset of the Moon Forge collection (wrong collection, or burned)');
      if (!record) reasons.push('no Moon Forge ArtifactRecord for it (not minted by the program)');
      else {
        if (!toPk(record.asset).equals(pk)) reasons.push('the record names another asset');
        if (!PDA.asset(Number(record.tier), Number(record.serial)).equals(pk)) reasons.push('the asset is not at the program\'s address for its tier and serial');
      }
      return { asset: pk.toBase58(), genuine: reasons.length === 0, reasons, owner: owner?.toBase58() ?? null, record };
    },
    /**
     * Everything about one Artifact: tier, origin, floor, forge price paid, holder, genuineness, the TransferDelegate
     * state, an open listing (and whether a buy would pass Core), the tier's price now, and in-season status for the
     * extra pot (forged less than 52 weeks ago).
     */
    async artifactInfo(asset) {
      const pk = toPk(asset);
      const g = await this.isGenuineArtifact(pk);
      const out = { ...g, record: undefined };
      if (!g.record) return out;
      const r = g.record;
      const origin = Number(r.origin), backing = BigInt(r.backing.toString());
      Object.assign(out, {
        tier: Number(r.tier), name: TIERS[Number(r.tier)], serial: Number(r.serial), origin: ORIGINS[origin] ?? origin, floorXnt: Number(backing) / XNT,
        forgePriceXnt: origin === 0 ? Number(2n * backing) / XNT : 0, forgedAt: Number(r.forgedAt.toString()),
      });
      const info = await this.connection.getAccountInfo(pk, 'confirmed');
      const core = info ? parseCoreAsset(info.data) : null;
      out.transferDelegate = core?.transferDelegate ? { type: core.transferDelegate.type, address: core.transferDelegate.address?.toBase58() ?? null } : core ? null : 'unreadable';
      if (this.rules === 3) {
        const [cfg, now] = await Promise.all([this.config(), this.chainTime()]);
        out.tierPriceNowXnt = Number(currentPrice(cfg, r.tier, now)) / XNT;
        out.inSeason = origin === 0 && Number(r.forgedAt.toString()) + 52 * 7 * DAY > now;
        out.minimumListPriceXnt = Number(minimumListPrice(backing)) / XNT;
        const listingPk = PDA.listing(pk);
        const l = await this.acc.listing?.fetchNullable(listingPk).catch(() => null);
        if (l) {
          const delegateOk = core?.transferDelegate?.type === 'address' && core.transferDelegate.address.equals(listingPk);
          const stale = !g.owner || g.owner !== toPk(l.seller).toBase58();
          const expired = Number(l.expiresAt.toString()) <= now;
          out.listing = {
            listing: listingPk.toBase58(), seller: toPk(l.seller).toBase58(), priceXnt: Number(l.price) / XNT, expiresAt: new Date(Number(l.expiresAt.toString()) * 1000).toISOString(),
            reservedBuyer: toPk(l.reservedBuyer).equals(PublicKey.default) ? null : toPk(l.reservedBuyer).toBase58(),
            split: Object.fromEntries(Object.entries(marketSplit(l.price.toString())).map(([k, v]) => [k, Number(v) / XNT])),
            stale, expired, delegateOk, buyable: !stale && !expired && delegateOk,
          };
        }
      }
      return out;
    },

    /**
     * Transfers an Artifact you hold to `to` (a Metaplex Core TransferV1 signed by this wallet). Refuses a destination
     * that is not a wallet (programs, sysvars, the zero key; off-curve addresses unless allowOffCurve), and, under the
     * final upgrade, an Artifact with an open listing (delist first to get its rent back) unless allowListed. The
     * extra-pot use follows the holder: the new holder counts from the next weekly snapshot.
     */
    async transferArtifact(asset, to, { allowListed = false, allowOffCurve = false, allowNonWallet = false } = {}) {
      const rules = await this.requireLiveCall('transferArtifact');
      const pk = toPk(asset);
      const dest = checkX1Destination(typeof to === 'string' ? to : toPk(to).toBase58(), { allowOffCurve });
      if (dest.pubkey.equals(this.me)) throw new Error('transferArtifact: the destination is this wallet. Nothing was sent.');
      const kind = await inspectX1Destination(this.connection, dest.b58);
      if (kind.kind === 'executable' || (kind.kind === 'owned' && !allowNonWallet)) throw new Error(`transferArtifact: ${dest.b58} is not a wallet (${kind.kind}${kind.owner ? `, owner ${kind.owner}` : ''}). Nothing was sent.`);
      const g = await this.isGenuineArtifact(pk);
      if (!g.genuine) throw new Error(`transferArtifact: ${pk.toBase58()} is not a genuine Moon Forge Artifact (${g.reasons.join('; ')}). Nothing was sent.`);
      if (g.owner !== this.me.toBase58()) throw new Error(`transferArtifact: ${pk.toBase58()} is held by ${g.owner}, not by this wallet. Nothing was sent.`);
      if (rules === 3 && !allowListed && this.acc.listing) {
        const l = await this.acc.listing.fetchNullable(PDA.listing(pk)).catch(() => null);
        if (l) throw new Error('transferArtifact: this Artifact has an open listing; delistArtifact(asset) first (its rent comes back), or pass allowListed:true (the listing goes stale). Nothing was sent.');
      }
      const ix = new TransactionInstruction({
        programId: MPL_CORE,
        keys: [
          { pubkey: pk, isSigner: false, isWritable: true },
          { pubkey: PDA.collection(), isSigner: false, isWritable: false },
          { pubkey: this.me, isSigner: true, isWritable: true },
          { pubkey: this.me, isSigner: true, isWritable: false },
          { pubkey: dest.pubkey, isSigner: false, isWritable: false },
          { pubkey: MPL_CORE, isSigner: false, isWritable: false },
          { pubkey: MPL_CORE, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([14, 0]), // TransferV1 { compression_proof: None }
      });
      const signature = await this.send(rawBuilder(ix), 'transferArtifact');
      return { signature, asset: pk.toBase58(), to: dest.b58 };
    },

    // ─── market ───────────────────────────────────────────────────────────────
    /** Open listings, optionally of one tier or one seller (Listing PDAs; the filter offsets come from the IDL in use). */
    async listings({ tier, seller } = {}) {
      await this.requireV3('listings', 'list_artifact');
      const idl = this.program.rawIdl ?? this.program.idl;
      const filters = [];
      if (seller) filters.push({ memcmp: { offset: accountFieldOffset(idl, 'Listing', 'seller'), bytes: toPk(seller).toBase58() } });
      if (tier !== undefined) filters.push({ memcmp: { offset: accountFieldOffset(idl, 'Listing', 'tier'), bytes: bs58.encode(Buffer.from([Number(tier)])) } });
      const all = await this.acc.listing.all(filters);
      const now = await this.chainTime();
      return all.map((l) => ({
        listing: l.publicKey.toBase58(), asset: toPk(l.account.asset).toBase58(), seller: toPk(l.account.seller).toBase58(), tier: Number(l.account.tier),
        priceXnt: Number(l.account.price) / XNT, expiresAt: Number(l.account.expiresAt.toString()), expired: Number(l.account.expiresAt.toString()) <= now,
        reservedBuyer: toPk(l.account.reservedBuyer).equals(PublicKey.default) ? null : toPk(l.account.reservedBuyer).toBase58(),
      }));
    },
    /**
     * Lists an Artifact you hold at `priceXnt` (the NFT stays in your wallet; the listing PDA becomes its transfer
     * delegate). The seller receives the price minus 5% (architect) and 2% (base pot), never less than the floor.
     * Options: expiresInDays (1..90, default 30), reservedBuyer (a private sale), addPlugin (normally read from the asset).
     */
    async listArtifact(asset, priceXnt, { expiresInDays = 30, reservedBuyer = null, addPlugin } = {}) {
      await this.requireV3('listArtifact', 'list_artifact');
      const pk = toPk(asset);
      const g = await this.isGenuineArtifact(pk);
      if (!g.genuine) throw new Error(`listArtifact: not a genuine Moon Forge Artifact (${g.reasons.join('; ')}). Nothing was sent.`);
      if (g.owner !== this.me.toBase58()) throw new Error(`listArtifact: held by ${g.owner}, not by this wallet. Nothing was sent.`);
      const price = lamports(priceXnt);
      const problem = listingPriceProblem(price, g.record.backing.toString());
      if (problem) throw new Error(`listArtifact: ${problem} (ListingBelowFloor; the lowest price is ${Number(minimumListPrice(g.record.backing.toString())) / XNT} XNT). Nothing was sent.`);
      if (!(expiresInDays > 0 && expiresInDays <= 90)) throw new Error('listArtifact: expiresInDays must be above 0 and at most 90 (InvalidExpiry). Nothing was sent.');
      const now = await this.chainTime();
      const expiresAt = now + Math.floor(expiresInDays * DAY) - 60;
      const listingPk = PDA.listing(pk);
      const existing = await this.acc.listing.fetchNullable(listingPk).catch(() => null);
      if (existing) {
        if (toPk(existing.seller).equals(this.me)) throw new Error('listArtifact: you already listed it; use updateListing(asset, price). Nothing was sent.');
        await this.closeListing(pk); // a stale listing by the previous holder: its rent goes back to that seller
      }
      let plugin = addPlugin;
      if (plugin === undefined) {
        const core = parseCoreAsset((await this.connection.getAccountInfo(pk, 'confirmed'))?.data);
        if (!core || core.plugins === null) throw new Error('listArtifact: the asset\'s plugins could not be read; pass addPlugin (true when it has no TransferDelegate plugin). Nothing was sent.');
        plugin = !core.transferDelegate;
      }
      const reserved = reservedBuyer ? toPk(reservedBuyer) : PublicKey.default;
      if (reserved.equals(this.me)) throw new Error('listArtifact: the reserved buyer is this wallet (SelfPurchase). Nothing was sent.');
      const signature = await this.send(this.program.methods.listArtifact(bn(price), bn(expiresAt), reserved, plugin).accountsPartial({
        config: PDA.config(), listing: listingPk, asset: pk, record: PDA.artifact(pk), collection: PDA.collection(), seller: this.me, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
      }), 'listArtifact', { needLamports: BigInt(await this.rentFor('listing')) });
      return { signature, listing: listingPk.toBase58(), priceXnt: Number(price) / XNT, sellerNetXnt: Number(marketSplit(price).sellerNet) / XNT, expiresAt: new Date(expiresAt * 1000).toISOString() };
    },
    /** Changes the price, expiry or reserved buyer of your listing (and renews its transfer delegate). */
    async updateListing(asset, priceXnt, { expiresInDays = 30, reservedBuyer = null } = {}) {
      await this.requireV3('updateListing', 'update_listing');
      const pk = toPk(asset);
      const l = await this.acc.listing.fetchNullable(PDA.listing(pk));
      if (!l) throw new Error('updateListing: no listing for this Artifact. Nothing was sent.');
      if (!toPk(l.seller).equals(this.me)) throw new Error('updateListing: the listing is not yours (Unauthorized). Nothing was sent.');
      const rec = await this.acc.artifactRecord.fetch(PDA.artifact(pk));
      const price = lamports(priceXnt);
      const problem = listingPriceProblem(price, rec.backing.toString());
      if (problem) throw new Error(`updateListing: ${problem}. Nothing was sent.`);
      const expiresAt = (await this.chainTime()) + Math.floor(expiresInDays * DAY) - 60;
      return this.send(this.program.methods.updateListing(bn(price), bn(expiresAt), reservedBuyer ? toPk(reservedBuyer) : PublicKey.default).accountsPartial({
        config: PDA.config(), listing: PDA.listing(pk), asset: pk, record: PDA.artifact(pk), collection: PDA.collection(), seller: this.me, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
      }), 'updateListing');
    },
    /** Removes your listing (its rent comes back; the transfer delegate is revoked). */
    async delistArtifact(asset) {
      await this.requireV3('delistArtifact', 'delist_artifact');
      const pk = toPk(asset);
      const l = await this.acc.listing.fetchNullable(PDA.listing(pk));
      if (!l) throw new Error('delistArtifact: no listing for this Artifact. Nothing was sent.');
      if (!toPk(l.seller).equals(this.me)) throw new Error('delistArtifact: the listing is not yours. Nothing was sent.');
      return this.send(this.program.methods.delistArtifact().accountsPartial({
        config: PDA.config(), listing: PDA.listing(pk), asset: pk, collection: PDA.collection(), seller: this.me, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
      }), 'delistArtifact');
    },
    /** Closes a stale (the seller no longer holds the asset) or expired listing (permissionless; the rent goes to the seller). */
    async closeListing(asset) {
      await this.requireV3('closeListing', 'close_listing');
      const pk = toPk(asset);
      const l = await this.acc.listing.fetchNullable(PDA.listing(pk));
      if (!l) throw new Error('closeListing: no listing for this Artifact. Nothing was sent.');
      return this.send(this.program.methods.closeListing().accountsPartial({ config: PDA.config(), listing: PDA.listing(pk), seller: l.seller, asset: pk, collection: PDA.collection() }), 'closeListing');
    },
    /**
     * Buys a listed Artifact at its listed price, never above `maxPriceXnt` (default: the price read now). Refused before
     * anything is sent when the listing is expired, reserved for another wallet, yours, stale, or its transfer delegate
     * is not the listing (Core would refuse the transfer).
     */
    async buyArtifact(asset, { maxPriceXnt } = {}) {
      await this.requireV3('buyArtifact', 'buy_artifact');
      const info = await this.artifactInfo(asset);
      const l = info.listing;
      if (!l) throw new Error('buyArtifact: this Artifact is not listed. Nothing was sent.');
      if (!info.genuine) throw new Error(`buyArtifact: not a genuine Moon Forge Artifact (${info.reasons.join('; ')}). Nothing was sent.`);
      if (l.expired) throw new Error('buyArtifact: the listing has expired (ListingExpired). Nothing was sent.');
      if (l.stale) throw new Error('buyArtifact: the seller no longer holds this Artifact (ListingStale). Nothing was sent.');
      if (l.seller === this.me.toBase58()) throw new Error('buyArtifact: this is your own listing (SelfPurchase). Nothing was sent.');
      if (l.reservedBuyer && l.reservedBuyer !== this.me.toBase58()) throw new Error('buyArtifact: the listing is reserved for another wallet (ListingReserved). Nothing was sent.');
      if (!l.delegateOk) throw new Error('buyArtifact: the asset\'s transfer delegate is not the listing, so Core would refuse the transfer; the seller must update the listing. Nothing was sent.');
      const pk = toPk(asset);
      const listing = await this.acc.listing.fetch(PDA.listing(pk));
      const price = BigInt(listing.price.toString());
      const max = maxPriceXnt === undefined ? price : lamports(maxPriceXnt);
      if (price > max) throw new Error(`buyArtifact: the price is ${Number(price) / XNT} XNT, above your maximum ${Number(max) / XNT} XNT. Nothing was sent.`);
      const cfg = await this.config();
      const signature = await this.send(this.program.methods.buyArtifact(bn(price)).accountsPartial({
        config: PDA.config(), listing: PDA.listing(pk), asset: pk, record: PDA.artifact(pk), collection: PDA.collection(), buyer: this.me, seller: listing.seller,
        architect: cfg.architect, rewardVault: PDA.rewardVault(), coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
      }), 'buyArtifact', { needLamports: price });
      return { signature, priceXnt: Number(price) / XNT, floorXnt: info.floorXnt };
    },

    // ─── the extra pot ────────────────────────────────────────────────────────
    /**
     * Verifies `wallet`'s leaf in extra epoch `epoch` (extra-<n>.json from connect({ epochs })) against the ExtraEpoch
     * account: the file's own checks, the leaf and proof, root, data hash, budget and leaf count, the 48-h hold, the
     * 90-day window and the claim bitmap. Returns { ok, claimable, amountXnt, index, proof, reasons[] }.
     */
    async verifyExtraClaim(epoch, { wallet = this.me } = {}) {
      await this.requireV3('verifyExtraClaim', 'claim_extra');
      const f = await this.epochSource('verifyExtraClaim').extra(epoch);
      if (!f) return { ok: false, epoch, reasons: [`extra-${epoch}.json is not in ${this.epochs.describe}`] };
      const reasons = [];
      const file = verifyExtraFileOffline(f);
      if (!file.ok) reasons.push(...file.problems.map((p) => `file: ${p}`));
      const leaf = extraLeafOf(f, wallet);
      if (!leaf) return { ok: false, epoch, wallet: toPk(wallet).toBase58(), reasons: [...reasons, 'no extra leaf for this wallet in this epoch'] };
      if (!verifyProof(leaf.proof, f.root, Buffer.from(leaf.hash, 'hex'))) reasons.push('the proof does not lead to the file root');
      const acc = await this.acc.extraEpoch.fetchNullable(PDA.extraEpoch(epoch));
      reasons.push(...compareWithChain(f, acc).map((p) => `chain: ${p}`));
      const now = await this.chainTime();
      const publishedAt = acc ? Number(acc.publishedAt.toString()) : null;
      const claimed = acc ? (acc.bitmap[Math.floor(leaf.index / 8)] & (1 << (leaf.index % 8))) !== 0 : false;
      const onHold = !!acc && now < publishedAt + V3.CLAIM_HOLD;
      const closed = !!acc && (acc.closed || now >= publishedAt + V3.CLAIM_WINDOW);
      const ok = reasons.length === 0;
      return {
        ok, epoch, wallet: toPk(wallet).toBase58(), index: leaf.index, amount: leaf.amount, amountXnt: Number(leaf.amount) / XNT, proof: leaf.proof,
        claimed, onHold, closed, claimableFrom: onHold ? publishedAt + V3.CLAIM_HOLD : null, claimable: ok && !claimed && !onHold && !closed, reasons,
      };
    },
    /** Claims `wallet`'s extra-pot rebate of `epoch` (permissionless: this wallet pays the fee, the XNT goes to the leaf wallet). */
    async claimExtra(epoch, { wallet = this.me } = {}) {
      await this.requireV3('claimExtra', 'claim_extra');
      const v = await this.verifyExtraClaim(epoch, { wallet });
      if (!v.ok) throw new Error(`claimExtra: extra epoch ${epoch} does not verify: ${v.reasons.slice(0, 3).join('; ')}. Nothing was sent.`);
      if (v.claimed) throw new Error('claimExtra: already claimed (ExtraAlreadyClaimed). Nothing was sent.');
      if (v.closed) throw new Error('claimExtra: the 90-day window of this extra epoch has ended (ExtraClaimWindow). Nothing was sent.');
      if (v.onHold) throw new Error(`claimExtra: claims open 48 h after publication (ClaimOnHold), at ${new Date(v.claimableFrom * 1000).toISOString()}. Nothing was sent.`);
      const signature = await this.send(this.program.methods.claimExtra(bn(epoch), v.index, bn(v.amount), v.proof.map((h) => Array.from(Buffer.from(h, 'hex')))).accountsPartial({
        config: PDA.config(), extraState: PDA.extraState(), extraEpoch: PDA.extraEpoch(epoch), extraVault: PDA.extraVault(), wallet: toPk(wallet), payer: this.me, systemProgram: SystemProgram.programId,
      }), 'claimExtra');
      return { signature, epoch, amountXnt: v.amountXnt };
    },
    /** claimExtra() for every claimable extra leaf of `wallet` in the extra files of the last `last` base epochs. */
    async claimAllExtra({ wallet = this.me, last = 13 } = {}) {
      await this.requireV3('claimAllExtra', 'claim_extra');
      const idx = await this.epochSource('claimAllExtra').index();
      const out = [];
      for (const e of idx.epochs.slice(-last)) {
        const v = await this.verifyExtraClaim(e.epoch, { wallet }).catch(() => null);
        if (!v?.claimable) continue;
        try { out.push(await this.claimExtra(e.epoch, { wallet })); } catch (err) { out.push({ epoch: e.epoch, error: String(err?.message ?? err).slice(0, 200) }); }
      }
      return out;
    },
  };
  for (const [k, v] of Object.entries(methods)) Object.defineProperty(Cls.prototype, k, { value: v, writable: true, configurable: true });
}

export { hex as toHex };
