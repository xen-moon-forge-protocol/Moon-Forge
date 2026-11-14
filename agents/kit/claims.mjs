/**
 * The burner's exits on X1, without the website: read your burns and leaves from the oracle's epoch files, verify a
 * leaf against the root the program stored, claim it (for yourself or for another wallet: the XNT always goes to the
 * wallet in the leaf), withdraw vested missions, eject, donate, claim the Genesis airdrop, and the week's capacity under
 * the v3 rules. Installed on MoonForge by moonforge.mjs (installClaims); every method is read-only or sends a call the
 * live program already has. Under the final upgrade (rules 3) a claim opens 48 h after its epoch's publication.
 *
 * Epoch files come from connect({ epochs }) (a directory, a mirror URL, or 'site'); a file is trusted only after its
 * leaf, proof, root and data hash match the program's Epoch account.
 */
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { airdropLeaf, compareWithChain, leafOf, verifyEpochFileOffline, verifyProof } from './verify-leaf.mjs';
import { allocateWindow, capOnDay, capacityOf, DAY, EPOCH_DAYS, V3_SWITCH, weekCapacityV3 } from './quote-v3.mjs';
import { feedInputs, feedProblems } from './burn.mjs';
import { V3 } from './rules-v3.mjs';
import { AIRDROP_URL } from './epochs.mjs';

const hex = (b) => Buffer.from(b).toString('hex');
const toPk = (x) => (x instanceof PublicKey ? x : new PublicKey(x));
const TIER_PENALTY_BPS = [0n, 6_000n, 7_500n];
const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/**
 * The program events history() keeps (names as the IDLs spell them; the three that exist only in the upgraded
 * program's IDL, BetRefunded, ArtifactSold and ExtraClaimed, simply never appear under the live rules). A unit test
 * checks every name against the bundled IDLs.
 */
export const HISTORY_EVENTS = Object.freeze(new Set([
  'BetSettled', 'BetRefunded', 'WarFinished', 'DuelResolved', 'ArtifactForged', 'ArtifactRecycled', 'ArtifactSold', 'ForgeClaimed',
  'ExtraClaimed', 'HouseChanged', 'Donated', 'PredictionResolved', 'VestedWithdrawn', 'PilotEjected', 'JackpotSettled', 'DrawSettled', 'DropWon',
]));
/** The XNT amount (lamports) an event row shows, or null. */
export const historyAmount = (d) => d.payout ?? d.amount ?? d.paid ?? d.prize ?? d.lamports ?? d.price ?? d.backingReturned ?? d.value ?? d.pot ?? d.stake ?? null;
/** The note column of an event row. */
export function historyNote(name, d, who) {
  if (d.won !== undefined) return d.won ? 'won' : 'lost';
  if (name === 'HouseChanged') return d.deposit ? 'Be the House deposit' : 'Be the House withdrawal';
  if (name === 'WarFinished' || name === 'DuelResolved' || name === 'JackpotSettled' || name === 'DrawSettled') {
    if (!d.winner) return '';
    const w = toPk(d.winner);
    return w.equals(PublicKey.default) ? 'draw or refund' : w.equals(toPk(who)) ? 'won' : 'not won';
  }
  if (name === 'PilotEjected') return `penalty ${Number((d.penaltyToPool ?? 0).toString()) / 1e9} XNT to the pool`;
  return '';
}

export const CLAIM_NOTICES = Object.freeze({
  airdrop: 'The Genesis claim is paused on the website until the planned program upgrade; the program accepts it. A Genesis '
    + 'Artifact has no floor: recycling it returns only the account rent. Under the current rules it is the Duel and Moon Wars '
    + 'ticket; the final upgrade (planned, earliest 2026-11-25) removes the ticket and gives Genesis no rebate. Claim only from '
    + 'your own machine with the listed wallet, never through a link someone sent you.',
  airdropV3: 'A Genesis Artifact (the Genesis airdrop: listed X1 validator withdraw authorities, first 120) is a collectible of the '
    + 'official collection with no floor: recycling it returns only the account rent; it is not eligible for the rebate and not '
    + 'needed to play, burn or claim. Claim only from your own machine with the listed wallet, never through a link someone sent you.',
  eject: 'Ejecting a mission pays its vested part in full and the unvested part minus the tier penalty (Orbit 60%, Moon '
    + 'Landing 75% of the unvested part goes to the reward pool): it always pays less than waiting.',
});

async function missionOf(mf, mission) {
  if (mission?.publicKey && mission?.account) return mission;
  const pk = toPk(mission);
  const account = await mf.acc.mission.fetchNullable(pk);
  if (!account) throw new Error(`no mission account ${pk.toBase58()}`);
  return { publicKey: pk, account };
}

export function installClaims(Cls, { anchor, PDA, XNT, sleep }) {
  const bn = (n) => new anchor.BN(n.toString());
  const methods = {
    // ─── epoch files ──────────────────────────────────────────────────────────
    /** The Epoch account of `n` (null when not published). */
    epochAccount(n) { return this.acc.epoch.fetchNullable(PDA.epoch(n)); },
    /** The base epoch file `n` from the configured source, checked offline (leaves, root, proofs, data hash). */
    async epochFile(n, { verify = true } = {}) {
      const f = await this.epochSource('epochFile').epoch(n);
      if (!f) return null;
      if (verify) {
        const r = verifyEpochFileOffline(f);
        if (!r.ok) throw new Error(`epoch-${n}.json from ${this.epochs.describe} fails its own checks: ${r.problems.slice(0, 3).join('; ')}`);
      }
      return f;
    },

    /**
     * Verifies one leaf of `owner` (default this wallet) end to end: the file's own checks, the leaf hash, its proof to the
     * root, and the root, data hash, total score and leaf count of the program's Epoch account; then whether it can be
     * claimed now. Returns { ok, epoch, tier, score, leafHash, proof, root, onChain, claimed, claimable, reasons[] }.
     */
    async verifyMyClaim(epoch, { tier, owner = this.me } = {}) {
      const who = toPk(owner);
      const f = await this.epochSource('verifyMyClaim').epoch(epoch);
      if (!f) return { ok: false, epoch, reasons: [`epoch-${epoch}.json is not in ${this.epochs.describe}`] };
      const reasons = [];
      const file = verifyEpochFileOffline(f);
      if (!file.ok) reasons.push(...file.problems.map((p) => `file: ${p}`));
      const tiers = tier === undefined ? [0, 1, 2] : [Number(tier)];
      const leaf = tiers.map((t) => leafOf(f, who, t)).find(Boolean) ?? null;
      if (!leaf) return { ok: false, epoch, owner: who.toBase58(), reasons: [...reasons, `no leaf for ${who.toBase58()}${tier === undefined ? '' : ` at tier ${tier}`} in epoch ${epoch}`] };
      if (!verifyProof(leaf.proof, f.root, Buffer.from(leaf.hash, 'hex'))) reasons.push('the proof does not lead from the leaf to the file root');
      const acc = await this.epochAccount(epoch);
      reasons.push(...compareWithChain(f, acc).map((p) => `chain: ${p}`));
      const receipt = await this.connection.getAccountInfo(PDA.receipt(epoch, who, leaf.tier));
      const now = await this.chainTime();
      const publishedAt = acc ? Number(acc.publishedAt.toString()) : null, expiresAt = acc ? Number(acc.expiresAt.toString()) : null;
      const onHold = this.rules === 3 && acc && now < publishedAt + V3.CLAIM_HOLD;
      const expired = !!acc && (acc.closed || now >= expiresAt);
      const ok = reasons.length === 0;
      const estimate = acc ? (BigInt(leaf.score) * BigInt(acc.budget.toString())) / BigInt(acc.totalScore.toString()) : null;
      return {
        ok, epoch, owner: who.toBase58(), tier: leaf.tier, score: leaf.score, leafHash: leaf.hash, proof: leaf.proof, root: f.root,
        onChain: acc ? { root: hex(acc.root), dataHash: hex(acc.dataHash), totalScore: acc.totalScore.toString(), leaves: Number(acc.leaves), publishedAt, expiresAt, closed: !!acc.closed } : null,
        claimed: !!receipt, expired, onHold: !!onHold, claimableFrom: onHold ? publishedAt + V3.CLAIM_HOLD : null,
        estimateXnt: estimate === null ? null : Number(estimate) / XNT,
        claimable: ok && !receipt && !expired && !onHold,
        reasons,
      };
    },

    /** Every leaf of `owner` in the last `last` epochs of the source, with its claim state (see verifyMyClaim). */
    async myLeaves({ owner = this.me, last = 20 } = {}) {
      const src = this.epochSource('myLeaves');
      const idx = await src.index();
      const out = [];
      const who = toPk(owner).toBase58();
      for (const e of idx.epochs.slice(-last)) {
        const f = await src.epoch(e.epoch);
        if (!f) continue;
        for (const l of (f.leaves ?? []).filter((x) => x.player === who)) out.push(await this.verifyMyClaim(e.epoch, { tier: l.tier, owner }));
      }
      return out;
    },

    /**
     * The burns whose X1 destination is `owner`, from the epoch files (and, with `feed`, the burns of the week so far
     * that no file holds yet): chain, transaction, amount, tier, and for v3 files what each was paid.
     */
    async myBurns({ owner = this.me, last = 20, feed = null } = {}) {
      const who = toPk(owner).toBase58();
      const src = this.epochSource('myBurns');
      const idx = await src.index();
      const out = [];
      for (const e of idx.epochs.slice(-last)) {
        const f = await src.epoch(e.epoch);
        if (!f) continue;
        for (const b of (f.burns ?? []).filter((x) => x.x1 === who)) {
          out.push({
            epoch: f.epoch, rules: f.version, chainId: b.chainId, txHash: b.txHash, logIndex: b.logIndex, missionId: b.missionId, timestamp: b.timestamp,
            at: new Date(b.timestamp * 1000).toISOString(), amountWei: b.amountWei, tier: b.tier,
            ...(f.version === 3 ? { paidLamports: b.alloc, basePaid: b.basePaid, bandPaid: b.bandPaid, leafTier: b.leafTier, converted: b.converted } : {}),
          });
        }
      }
      if (feed && feedProblems(feed, { maxAgeSec: 7 * DAY }).length === 0) {
        for (const c of feed.chains) for (const b of (c.burns ?? []).filter((x) => x.x1 === who)) {
          out.push({ epoch: feed.epoch, rules: 3, pending: true, chainId: b.chainId, txHash: b.txHash, logIndex: b.logIndex, missionId: b.missionId, timestamp: b.timestamp, at: new Date(b.timestamp * 1000).toISOString(), amountWei: b.amountWei, tier: b.tier });
        }
      }
      return out.sort((a, b) => a.timestamp - b.timestamp);
    },

    // ─── claims ───────────────────────────────────────────────────────────────
    /**
     * Claims one leaf: `owner`'s (default this wallet) leaf in `epoch` (the tier is found when omitted). This wallet pays
     * the fee and the receipt rent; the XNT goes to the leaf's wallet (a Launchpad payout, or a vesting Mission for tiers
     * 1-2). The leaf is verified against the chain first; an already claimed, expired or (rules 3) held leaf is refused.
     */
    async claim(epoch, { tier, owner = this.me } = {}) {
      await this.requireLiveCall('claim');
      const v = await this.verifyMyClaim(epoch, { tier, owner });
      if (!v.ok) throw new Error(`claim: epoch ${epoch} leaf does not verify against the chain: ${v.reasons.slice(0, 3).join('; ')}. Nothing was sent.`);
      if (v.claimed) throw new Error(`claim: epoch ${epoch} tier ${v.tier} is already claimed for ${v.owner}. Nothing was sent.`);
      if (v.expired) throw new Error(`claim: epoch ${epoch} is past its 90-day claim window. Nothing was sent.`);
      if (v.onHold) throw new Error(`claim: claims of epoch ${epoch} open 48 h after its publication (ClaimOnHold), at ${new Date(v.claimableFrom * 1000).toISOString()}. Nothing was sent.`);
      const player = toPk(owner);
      const proof = v.proof.map((h) => Array.from(Buffer.from(h, 'hex')));
      const common = {
        config: PDA.config(), epoch: PDA.epoch(epoch), receipt: PDA.receipt(epoch, player, v.tier), player, playerState: PDA.player(player),
        rewardVault: PDA.rewardVault(), payer: this.me, systemProgram: SystemProgram.programId,
      };
      const rent = BigInt(await this.connection.getMinimumBalanceForRentExemption(this.acc.claimReceipt.size));
      const signature = v.tier === 0
        ? await this.send(this.program.methods.claimInstant(bn(epoch), v.tier, bn(v.score), proof).accountsPartial(common), 'claimInstant', { needLamports: rent })
        : await this.send(this.program.methods.claimMission(bn(epoch), v.tier, bn(v.score), proof).accountsPartial({ ...common, mission: PDA.mission(epoch, player, v.tier) }), 'claimMission', { needLamports: rent + BigInt(await this.connection.getMinimumBalanceForRentExemption(this.acc.mission.size)) });
      return { signature, epoch, tier: v.tier, owner: v.owner, estimateXnt: v.estimateXnt };
    },
    /** claim() for another wallet: this wallet pays the fee and rent, the XNT goes to `owner`. */
    claimFor(owner, epoch, opts = {}) { return this.claim(epoch, { ...opts, owner }); },
    /** Claims every claimable leaf of `owner` in the last `last` epochs; returns [{ epoch, tier, signature } | { epoch, tier, error }]. */
    async claimAll({ owner = this.me, last = 20 } = {}) {
      const out = [];
      for (const l of await this.myLeaves({ owner, last })) {
        if (!l.claimable) continue;
        try { out.push(await this.claim(l.epoch, { tier: l.tier, owner })); } catch (e) { out.push({ epoch: l.epoch, tier: l.tier, error: String(e?.message ?? e).slice(0, 200) }); }
      }
      return out;
    },

    // ─── missions (vesting tiers) ─────────────────────────────────────────────
    /** The vesting missions of `owner`, with what is withdrawable now and what an eject would pay. */
    async myMissions({ owner = this.me } = {}) {
      const all = await this.acc.mission.all([{ memcmp: { offset: 8, bytes: toPk(owner).toBase58() } }]);
      const now = await this.chainTime();
      return all.map((m) => ({ publicKey: m.publicKey, account: m.account, ...this.missionPreview(m.account, now) }));
    },
    /** Pure mirror of forge.rs withdraw_vested / eject at `now`: { vested, withdrawable, unvested, penalty, ejectPays } in lamports. */
    missionPreview(m, now) {
      const total = BigInt(m.total.toString()), withdrawn = BigInt(m.withdrawn.toString()), start = BigInt(m.start.toString()), end = BigInt(m.end.toString()), t = BigInt(now);
      const dur = end - start > 0n ? end - start : 1n, el = t - start > 0n ? t - start : 0n;
      const vested = t >= end ? total : (total * el) / dur;
      const withdrawable = vested > withdrawn ? vested - withdrawn : 0n;
      const unvested = total > vested ? total - vested : 0n;
      const penalty = (unvested * (TIER_PENALTY_BPS[Number(m.tier)] ?? 0n)) / 10_000n;
      return { epoch: Number(m.epoch.toString()), tier: Number(m.tier), total, vested, withdrawable, unvested, penalty, ejectPays: withdrawable + unvested - penalty, endsAt: new Date(Number(end) * 1000).toISOString() };
    },
    /** Withdraws what a mission has vested so far to its player's game wallet (anyone may send it; the XNT goes to the player). */
    async withdrawVested(mission) {
      await this.requireLiveCall('withdrawVested');
      const m = await missionOf(this, mission);
      const p = this.missionPreview(m.account, await this.chainTime());
      if (p.withdrawable === 0n) throw new Error('withdrawVested: nothing has vested since the last withdrawal (NothingVested). Nothing was sent.');
      const signature = await this.send(this.program.methods.withdrawVested().accountsPartial({
        mission: m.publicKey, player: m.account.player, playerState: PDA.player(m.account.player), rentPayer: m.account.rentPayer,
      }), 'withdrawVested');
      return { signature, withdrawnXnt: Number(p.withdrawable) / XNT };
    },
    /** withdrawVested() for every mission of `owner` with something vested. */
    async withdrawAllVested({ owner = this.me } = {}) {
      const out = [];
      for (const m of await this.myMissions({ owner })) {
        if (m.withdrawable === 0n) continue;
        try { out.push({ mission: m.publicKey.toBase58(), ...(await this.withdrawVested(m)) }); } catch (e) { out.push({ mission: m.publicKey.toBase58(), error: String(e?.message ?? e).slice(0, 200) }); }
      }
      return out;
    },
    /**
     * Ejects one of this wallet's missions: everything is paid now, minus the tier penalty on the unvested part (to the
     * reward pool). Refused unless { acceptPenalty: true }: the refusal carries the preview (lamports).
     */
    async eject(mission, { acceptPenalty = false } = {}) {
      await this.requireLiveCall('eject');
      const m = await missionOf(this, mission);
      if (!toPk(m.account.player).equals(this.me)) throw new Error('eject: only the mission\'s own player can eject it. Nothing was sent.');
      const p = this.missionPreview(m.account, await this.chainTime());
      if (!acceptPenalty) {
        const e = new Error(`eject: ${CLAIM_NOTICES.eject} Now it would pay ${Number(p.ejectPays) / XNT} XNT and send ${Number(p.penalty) / XNT} XNT to the pool; pass { acceptPenalty: true } to eject. Nothing was sent.`);
        e.preview = p;
        throw e;
      }
      const signature = await this.send(this.program.methods.eject().accountsPartial({
        config: PDA.config(), mission: m.publicKey, player: this.me, rewardVault: PDA.rewardVault(), rentPayer: m.account.rentPayer, playerState: PDA.player(this.me),
      }), 'eject');
      return { signature, paidXnt: Number(p.ejectPays) / XNT, penaltyXnt: Number(p.penalty) / XNT };
    },

    // ─── donate, airdrop ──────────────────────────────────────────────────────
    /**
     * Donates `xnt` from this wallet to a program vault: 'reward' (the reward pool that pays burners; it also funds the
     * keeper tips of future claims) or 'bankroll' (the game bankroll; donations mint no shares). A donation buys nothing.
     */
    async donate(target, xnt) {
      const rules = await this.requireLiveCall('donate');
      const t = { reward: 0, bankroll: 1, draw: 2 }[target] ?? (Number.isInteger(target) ? target : null);
      if (t === null || t < 0 || t > 2) throw new Error("donate: target is 'reward' or 'bankroll'");
      if (t === 2 && rules === 3) throw new Error('donate: the Burn Lottery is retired since the final upgrade; donate to the reward pool instead. Nothing was sent.');
      const lamports = BigInt(Math.round(Number(xnt) * XNT));
      if (lamports <= 0n) throw new Error('donate: the amount must be above 0');
      const vault = [PDA.rewardVault(), PDA.bankrollVault(), PDA.drawVault()][t];
      const signature = await this.send(this.program.methods.donate(t, bn(lamports)).accountsPartial({ config: PDA.config(), donor: this.me, vault, systemProgram: SystemProgram.programId }), 'donate', { needLamports: lamports });
      return { signature, lamports };
    },

    // ─── Jackpot and Burn Lottery exits (permissionless; the rent goes back to whoever paid it) ─────────────
    /**
     * Closes Jackpot entry `index` of round `round` once the round is settled or refunded: a refunded round credits the
     * entry's stake back to its player's game wallet, and the entry's rent returns to whoever paid it. Anyone can send it
     * (this wallet pays only the fee). Works under the live rules and after the final upgrade.
     */
    async closeJackpotEntry(round, index) {
      await this.requireLiveCall('closeJackpotEntry');
      const roundPk = PDA.jackpot(BigInt(round));
      const entry = PDA.jpEntry(BigInt(round), Number(index));
      const [r, e] = await Promise.all([this.acc.jackpotRound.fetchNullable(roundPk), this.acc.jackpotEntry.fetchNullable(entry)]);
      if (!e) throw new Error(`closeJackpotEntry: no entry ${index} in Jackpot round ${round} (already closed?). Nothing was sent.`);
      if (!r || (r.state !== 2 && r.state !== 3)) throw new Error(`closeJackpotEntry: Jackpot round ${round} is not settled or refunded yet (RoundNotSettled). Nothing was sent.`);
      const signature = await this.send(this.program.methods.closeJackpotEntry().accountsPartial({
        round: roundPk, playerState: PDA.player(e.player), entry, rentPayer: e.rentPayer,
      }), 'closeJackpotEntry');
      return { signature, refunded: r.state === 3, amountXnt: r.state === 3 ? Number(e.amount.toString()) / XNT : 0 };
    },
    /**
     * Closes Burn Lottery entry `index` of round `round` once the round is settled: the entry's rent returns to whoever
     * paid it. The Lottery takes no new entries after the final upgrade; its open rounds still settle and close this way.
     */
    async closeDrawEntry(round, index) {
      await this.requireLiveCall('closeDrawEntry');
      const roundPk = PDA.draw(BigInt(round));
      const entry = PDA.drawEntry(BigInt(round), Number(index));
      const [r, e] = await Promise.all([this.acc.drawRound.fetchNullable(roundPk), this.acc.drawEntry.fetchNullable(entry)]);
      if (!e) throw new Error(`closeDrawEntry: no entry ${index} in Lottery round ${round} (already closed?). Nothing was sent.`);
      if (!r || r.state !== 2) throw new Error(`closeDrawEntry: Lottery round ${round} is not settled yet (RoundNotSettled). Nothing was sent.`);
      const signature = await this.send(this.program.methods.closeDrawEntry().accountsPartial({ round: roundPk, entry, rentPayer: e.rentPayer }), 'closeDrawEntry');
      return { signature };
    },
    /**
     * Claims this wallet's Genesis Artifact (the Genesis airdrop: listed X1 validator withdraw authorities, first 120).
     * `list`: the airdrop list ({ root, proofs }), a path to airdrop.json, or 'site' (HTTPS fetch of the site's copy).
     * The proof is checked against the root the program stores before anything is sent.
     */
    async claimAirdrop({ list } = {}) {
      const rules = await this.requireLiveCall('claimAirdrop');
      this.warn(rules === 3 ? 'airdrop:v3' : 'airdrop', rules === 3 ? CLAIM_NOTICES.airdropV3 : CLAIM_NOTICES.airdrop);
      let l = list;
      if (l === 'site') { const r = await fetch(AIRDROP_URL); if (!r.ok) throw new Error(`claimAirdrop: HTTP ${r.status}`); l = JSON.parse(await r.text()); }
      else if (typeof l === 'string') l = JSON.parse((await import('node:fs')).readFileSync(l, 'utf8'));
      if (!l?.proofs) throw new Error("claimAirdrop: pass { list }: the airdrop list object, a path to airdrop.json, or 'site'");
      const proof = l.proofs[this.me.toBase58()];
      if (!proof) throw new Error(`claimAirdrop: ${this.me.toBase58()} is not in the Genesis airdrop list. Nothing was sent.`);
      const cfg = await this.config();
      if (!cfg.airdropRootSet) throw new Error('claimAirdrop: the airdrop root is not set on chain (AirdropNotSet)');
      if (!verifyProof(proof, hex(cfg.airdropRoot), airdropLeaf(this.me))) throw new Error('claimAirdrop: the proof does not match the root stored by the program (wrong or tampered list). Nothing was sent.');
      if (await this.connection.getAccountInfo(PDA.airdrop(this.me))) throw new Error('claimAirdrop: this wallet already claimed its Genesis Artifact');
      if (Number(cfg.airdropClaimed) >= 120) throw new Error('claimAirdrop: all 120 Genesis Artifacts are claimed (AirdropExhausted)');
      if ((await this.chainTime()) >= V3.AIRDROP_DEADLINE) throw new Error('claimAirdrop: the claim period has ended (AirdropClosed)');
      const build = async () => {
        const c = await this.config();
        const serial = c.artifactsMinted[0];
        const asset = PDA.asset(0, serial);
        const b = this.program.methods.claimAirdrop(serial, proof.map((h) => Array.from(Buffer.from(h, 'hex')))).accountsPartial({
          config: PDA.config(), receipt: PDA.airdrop(this.me), asset, record: PDA.artifact(asset), collection: PDA.collection(),
          artifactAuthority: PDA.artifactAuthority(), claimant: this.me, coreProgram: new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'), systemProgram: SystemProgram.programId,
        });
        b.__asset = asset;
        return b;
      };
      let b = await build();
      const need = BigInt(await this.rentFor('artifactRecord')) + BigInt(await this.rentFor('airdropReceipt')) + BigInt(await this.connection.getMinimumBalanceForRentExemption(300));
      const signature = await this.send(b, 'claimAirdrop', { needLamports: need, rebuild: async () => (b = await build()) });
      return { signature, asset: b.__asset };
    },

    // ─── capacity (v3) ────────────────────────────────────────────────────────
    /**
     * The week's capacity. Under the v2 rules (today): the upper bound the program allows (10% of the free pool per epoch;
     * the rules are being replaced). Under the v3 rules (once the latest epoch file is v3, a v3 feed is passed, or the
     * switch is announced in quote-v3.mjs V3_SWITCH): C = 8% of F_ref (the free pool right after the previous publication),
     * opened in 7 daily tranches counted from that publication, the cumulative cap today, what is left today (needs the
     * week-so-far feed) and a projection of next week's C (not binding).
     */
    async capacity({ cfg, freeLamports, now, feed = null } = {}) {
      const c = cfg ?? await this.config();
      const t = now ?? await this.chainTime();
      let free = freeLamports;
      if (free === undefined) {
        const pool = await this.connection.getAccountInfo(PDA.rewardVault());
        const rent = pool ? await this.connection.getMinimumBalanceForRentExemption(pool.data.length) : 0;
        free = BigInt(Math.max(0, (pool?.lamports ?? 0) - rent - Number(c.rewardReserved)));
      }
      const upper = { rules: 'v2', weeklyCapUpperBoundXnt: Math.floor(Number(free) * 0.1) / XNT, text: 'current rules: an epoch pays at most 10% of the free pool (an upper bound, not a promise; the rules are being replaced)' };
      const lastEpoch = Number(c.lastEpoch.toString());
      let latest = null;
      if (this.epochs) latest = await this.epochs.latest().catch(() => null);
      const v3Week = (feed && feedProblems(feed, { now: t, maxAgeSec: 7 * DAY }).length === 0) || latest?.version === 3 || (V3_SWITCH && lastEpoch + 1 >= V3_SWITCH.firstEpoch);
      if (!v3Week) return { ...upper, available: !!this.epochs, reason: this.epochs ? 'the v3 rules do not apply yet (the latest epoch file is v2 and no switch is announced)' : 'pass connect({ epochs }) to read the epoch files' };
      if (!lastEpoch) return { ...upper, rules: 'v3', available: false, reason: 'no epoch published yet' };
      const ep = await this.epochAccount(lastEpoch);
      const startTs = Number(ep.publishedAt.toString());
      let Fref = feed?.freePool?.open ? BigInt(feed.freePool.open) : null;
      if (Fref === null && latest?.epoch === lastEpoch && latest.publish?.freePoolBefore && latest.publish?.budget) Fref = BigInt(latest.publish.freePoolBefore) - BigInt(latest.publish.budget);
      if (Fref === null) {
        const ev = await this.readEpochPublished(lastEpoch, latest?.epoch === lastEpoch ? latest.publish?.tx : null).catch(() => null);
        if (ev) Fref = BigInt(ev.freePoolBefore) - BigInt(ev.budget);
      }
      if (Fref === null) return { ...upper, rules: 'v3', available: false, reason: `F_ref (the free pool right after epoch ${lastEpoch}'s publication) could not be read` };
      // D-22 (a): C is ⌊8% F_ref⌋, never above 7 daily tranches of 2% of the XDEX XNT reserve read at epoch n−1's build
      const { C } = weekCapacityV3(Fref, latest?.epoch === lastEpoch && latest?.version === 3 ? latest : null);
      const day = Math.max(0, Math.floor((t - startTs) / DAY));
      const capToday = capOnDay(C, day);
      // what the week's burns so far took at their arrival (the engine over the feed), when a usable feed is passed
      let used = null;
      if (feed && latest?.epoch === lastEpoch && feedProblems(feed, { now: t }).length === 0) {
        // the window's own burns (a skipped chain's backlog and the operator burns rank after a new burn, D-12 / D-18)
        try { used = allocateWindow(latest, feedInputs(feed), { applyLimit: false }).capacity.seniorAhead; } catch { used = null; }
      }
      return {
        rules: 'v3', available: true, epoch: lastEpoch + 1, windowStartTs: startTs, windowStart: new Date(startTs * 1000).toISOString(),
        FrefLamports: Fref.toString(), CXnt: Number(C) / XNT, dailyTrancheXnt: Number(C / BigInt(EPOCH_DAYS)) / XNT, day,
        trancheOpensAt: new Date((startTs + day * DAY) * 1000).toISOString(), nextTrancheAt: day < 6 ? new Date((startTs + (day + 1) * DAY) * 1000).toISOString() : null,
        capTodayXnt: Number(capToday) / XNT, remainingTodayXnt: used === null ? null : Number(capToday > used ? capToday - used : 0n) / XNT,
        remainingNote: 'what is left today depends on the burns of the week so far: quoteBurn() with the week-so-far feed gives it exactly',
        nextWeekProjectionXnt: Number(capacityOf(free > C ? BigInt(free) - C : 0n)) / XNT,
        projectionNote: 'next week: 8% of the free pool after this week pays at most C; a projection, not binding (inflows and the burns of the week move it)',
      };
    },
    /** The EpochPublished event of epoch `n` (from its publish transaction): { epoch, root, dataHash, totalScore, leaves, budget, freePoolBefore }. */
    async readEpochPublished(n, signature = null) {
      let sig = signature;
      if (!sig) {
        const sigs = await this.connection.getSignaturesForAddress(PDA.epoch(n), { limit: 1000 });
        const ok = sigs.filter((s) => !s.err);
        sig = ok.length ? ok[ok.length - 1].signature : null;
      }
      if (!sig) return null;
      const t = await this.connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (!t?.meta || t.meta.err) return null;
      const parser = new anchor.EventParser(this.program.programId, new anchor.BorshCoder(this.program.idl));
      for (const e of parser.parseLogs(t.meta.logMessages ?? [], false)) {
        if ((e.name === 'EpochPublished' || e.name === 'epochPublished') && Number(e.data.epoch.toString()) === Number(n)) {
          return { tx: sig, epoch: Number(n), root: hex(e.data.root), dataHash: hex(e.data.dataHash), totalScore: e.data.totalScore.toString(), leaves: Number(e.data.leaves), budget: e.data.budget.toString(), freePoolBefore: e.data.freePoolBefore.toString() };
        }
      }
      return null;
    },

    // ─── history ──────────────────────────────────────────────────────────────
    /**
     * A CSV of what this wallet did and received: its burns and leaves from the epoch files (when connect({ epochs }) is
     * set), its missions, and the program events of its last `limit` transactions (bets, matches, duels, forges, claims,
     * sales). Columns: time_utc, kind, epoch, tier, amount_xnt, reference, note. Read-only.
     */
    async history({ owner = this.me, limit = 200, last = 20 } = {}) {
      const who = toPk(owner);
      const rows = [];
      if (this.epochs) {
        for (const b of await this.myBurns({ owner: who, last }).catch(() => [])) rows.push([b.at, b.pending ? 'burn (pending epoch)' : 'burn', b.epoch, b.tier, b.paidLamports ? Number(b.paidLamports) / XNT : '', `${b.chainId}:${b.txHash}`, `${(BigInt(b.amountWei) / 10n ** 18n).toString()} XEN`]);
        for (const l of await this.myLeaves({ owner: who, last }).catch(() => [])) rows.push([l.onChain?.publishedAt ? new Date(l.onChain.publishedAt * 1000).toISOString() : '', l.claimed ? 'leaf claimed' : 'leaf', l.epoch, l.tier, l.estimateXnt ?? '', `epoch ${l.epoch}`, l.ok ? 'verified against the chain' : l.reasons.join('; ').slice(0, 120)]);
      }
      for (const m of await this.myMissions({ owner: who }).catch(() => [])) rows.push(['', 'mission', m.epoch, m.tier, Number(m.total) / XNT, m.publicKey.toBase58(), `withdrawable ${Number(m.withdrawable) / XNT} XNT, ends ${m.endsAt}`]);
      const sigs = await this.connection.getSignaturesForAddress(who, { limit: Math.min(1000, limit) }).catch(() => []);
      const parser = new anchor.EventParser(this.program.programId, new anchor.BorshCoder(this.program.idl));
      const EVENTS = HISTORY_EVENTS;
      for (const s of sigs) {
        if (s.err) continue;
        const t = await this.connection.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
        if (!t?.meta) continue;
        let events = [];
        try { events = [...parser.parseLogs(t.meta.logMessages ?? [], false)]; } catch { events = []; }
        for (const e of events) {
          const name = e.name.charAt(0).toUpperCase() + e.name.slice(1);
          if (!EVENTS.has(name)) continue;
          const d = e.data;
          const amount = historyAmount(d);
          rows.push([t.blockTime ? new Date(t.blockTime * 1000).toISOString() : '', name, d.epoch?.toString?.() ?? '', d.tier ?? '', amount === null ? '' : Number(amount.toString()) / XNT, s.signature, historyNote(name, d, who)]);
        }
        await sleep(0);
      }
      rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      return ['time_utc,kind,epoch,tier,amount_xnt,reference,note', ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';
    },
  };
  for (const [k, v] of Object.entries(methods)) {
    if (k.startsWith('#')) continue;
    Object.defineProperty(Cls.prototype, k, { value: v, writable: true, configurable: true });
  }
}
