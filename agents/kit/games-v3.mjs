/**
 * Games after the final upgrade (rules 3), for an agent with its own key: house bets on the keeper's hash chain
 * (placeBetV2, anchorBet, waitBet, refundStalledBet), the sealed Artifact Duel (createDuelSealed, joinDuelSealed,
 * revealDuelJoin, revealDuel), sealed Moon Wars starts (createWarSealed, joinWarSealed, advanceStart; then the usual
 * moves and playMatch), and houseStats(). Installed on MoonForge by moonforge.mjs.
 *
 * Every method here sends an instruction that only the upgraded program has, so each one first checks that the
 * upgraded program is live (requireV3) and refuses cleanly before it: nothing changes for the live program.
 * Games of chance and player-versus-player stakes: you can lose the whole stake; not for anyone under 18 or where such
 * games are prohibited. Secrets are written to the secrets store before the transaction that commits to them.
 */
import crypto from 'node:crypto';
import { PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY } from '@solana/web3.js';
import {
  chainNextOk, duelCommitment, duelJoinCommitment, gameOdds, isAnchored, isSealedWar, keeperBetState, keeperView, rollFor, V3,
  warEntropyCommitment, warJoinCommitment,
} from './rules-v3.mjs';
import { randomHex32 } from './secrets.mjs';
import { programErrorName } from './errors.mjs';
import { accountFieldOffset, ixDiscriminatorHex } from './idl.mjs';
import bs58 from 'bs58';

const toPk = (x) => (x instanceof PublicKey ? x : new PublicKey(x));
/** The IDL in use, as written (snake_case names): the source of every layout fact (offsets, discriminators). */
const idlOf = (mf) => mf.program.rawIdl ?? mf.program.idl;
const b32 = (h) => Array.from(Buffer.from(h, 'hex'));
const ELEMENTS = ['Lunar', 'Cosmic', 'Solar', 'Void'];
/** A Duel joined sealed (a non-zero opponent commitment): only the upgraded program writes one. */
const sealedJoin = (d) => !!d && Array.isArray(d.opponentCommitment) && d.opponentCommitment.some((b) => b !== 0);
const pickElement = (el) => {
  if (el === undefined || el === 'random') return crypto.randomInt(0, 4);
  const n = typeof el === 'string' ? ELEMENTS.findIndex((x) => x.toLowerCase() === el.toLowerCase()) : Number(el);
  if (!(n >= 0 && n < 4)) throw new Error('element: 0..3 (Lunar, Cosmic, Solar, Void) or "random"');
  return n;
};
export const DUEL_STATE = Object.freeze({ OPEN: 0, JOINED: 1, DONE: 2 });
/**
 * What a house stall pays (keeper.rs stall_split / stall_moves, round 4 review F1, r4-fix): never anchored, the player
 * gets its whole stake back (the bankroll returns stake - edge, the keeper bond the edge) and the bond forfeits stake - edge
 * to nobody; stalled or skipped, the bond pays the payout and the bankroll keeps the stake as for a lost bet. The reward
 * pool and the architect keep only the placement edge.
 */
export const STALL_NOTES = Object.freeze({
  0: 'never anchored: the whole stake is refunded (stake - edge by the bankroll, the edge by the keeper bond, which also forfeits stake - edge)',
  1: 'stalled or skipped: paid as a win (the payout) from the keeper bond',
});

export function installGamesV3(Cls, { anchor, PDA, XNT, sleep, NOTICES_V3 }) {
  const bn = (n) => new anchor.BN(n.toString());
  const lamports = (xnt) => BigInt(Math.round(Number(xnt) * XNT));
  const methods = {
    // ─── house keeper ─────────────────────────────────────────────────────────
    /** The house keeper seat (rules 3): armed, positions left, bond, pending bets, idle days. */
    async houseKeeper() {
      const k = await this.acc.houseKeeper?.fetchNullable(PDA.houseKeeper()).catch(() => null);
      return keeperView(k ?? null, await this.chainTime());
    },
    /**
     * Places a house bet on the keeper's hash chain (place_bet_v2), then anchors it (anchor_bet) one slot later so the
     * keeper can reveal it. The outcome needs the keeper's next reveal: waitBet(bet) follows it. A bet the keeper does not
     * reveal within KEEPER_STALL_SLOTS (about a day), or whose position it skipped, is refundable as a win (the payout);
     * one never anchored within 512 slots (about 3 minutes) is refunded its whole stake. Since the final upgrade's round-4
     * fix the first is paid from the keeper's bond (the bankroll keeps the stake, as for a lost bet) and the second costs the
     * bond the whole stake too (the edge to the player, stake - edge forfeited to nobody), so a keeper that stalls its own
     * bets gains nothing, and nor does anyone else. Returns { bet, signature, anchored, odds }.
     */
    async placeBetV2(game, param, choice, stakeXnt, { anchor: doAnchor = true } = {}) {
      this.warn('houseGames');
      await this.requireV3('placeBetV2', 'place_bet_v2');
      const [chanceBps, payoutBps] = gameOdds(game, param, choice);
      const stake = lamports(stakeXnt);
      if (stake < V3.MIN_STAKE) throw new Error('placeBetV2: the minimum stake is 0.01 XNT. Nothing was sent.');
      const k = await this.houseKeeper();
      if (!k.armed) throw new Error(`placeBetV2: ${k.reason}. Nothing was sent.`);
      const cfg = await this.config();
      const ps = await this.ensurePlayer();
      const { nonce } = await this.acc.playerState.fetch(ps);
      const bet = PDA.bet(ps, BigInt(nonce.toString()));
      const signature = await this.send(this.program.methods.placeBetV2(game, bn(param), choice, bn(stake), Array.from(crypto.randomBytes(32))).accountsPartial({
        config: PDA.config(), playerState: ps, bet, bankrollVault: PDA.bankrollVault(), rewardVault: PDA.rewardVault(), architect: cfg.architect,
        signer: this.me, systemProgram: SystemProgram.programId, keeperSeat: PDA.houseKeeper(),
      }), 'placeBetV2', { needLamports: BigInt(await this.rentFor('bet')) });
      let anchored = false;
      if (doAnchor) {
        try { await this.anchorBet(bet); anchored = true; } catch (e) { this.onWarning(`placeBetV2: the bet is placed but not anchored yet (${String(e?.message ?? e).slice(0, 120)}); call anchorBet(${bet.toBase58()}) within about 3 minutes, or it is refunded later`); }
      }
      return { bet, signature, anchored, odds: { chanceBps, payoutBps } };
    },
    /** Anchors a keeper bet (permissionless): mixes the hash of the block after placement into its seed. Retries NotReady. */
    async anchorBet(bet, { tries = 25, intervalMs = 400 } = {}) {
      await this.requireV3('anchorBet', 'anchor_bet');
      let last = null;
      for (let i = 0; i < tries; i++) {
        const b = await this.acc.bet.fetchNullable(toPk(bet));
        if (!b) throw new Error('anchorBet: the bet account is closed (settled or refunded)');
        if (isAnchored(b.game)) return { anchored: true, seed: Buffer.from(b.seed).toString('hex') };
        try {
          await this.send(this.program.methods.anchorBet().accountsPartial({ bet: toPk(bet), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }), 'anchorBet');
          const after = await this.acc.bet.fetch(toPk(bet));
          return { anchored: true, seed: Buffer.from(after.seed).toString('hex') };
        } catch (e) {
          last = e;
          if (programErrorName(e) !== 'NotReady' && !/NotReady/.test(`${e?.message} ${JSON.stringify(e?.logs ?? [])}`)) throw e;
          await sleep(intervalMs);
        }
      }
      throw last ?? new Error('anchorBet: the anchor block did not appear in time');
    },
    /** Where a keeper bet stands: 'unanchored' | 'waiting' | 'refundable' (reason 0/1) | 'closed' | 'legacy'. */
    async betStatus(bet) {
      const pk = toPk(bet);
      const b = await this.acc.bet.fetchNullable(pk);
      if (!b) return { bet: pk.toBase58(), state: 'closed', note: 'settled or refunded (the account is closed)' };
      const k = await this.acc.houseKeeper?.fetchNullable(PDA.houseKeeper()).catch(() => null);
      const s = keeperBetState(b, k, await this.connection.getSlot('confirmed'));
      return { bet: pk.toBase58(), ...s, index: s.index?.toString(), anchor: s.anchor?.toString(), stakeXnt: Number(b.stake) / XNT, payoutXnt: Number(b.payout) / XNT, seed: Buffer.from(b.seed).toString('hex') };
    },
    /**
     * Waits for a keeper bet: anchors it if needed, then polls until the keeper's settle closes it (returns the result,
     * verified against the reveal when the settle transaction is found) or until it becomes refundable (refunds it when
     * `refund` is true, the default). Returns { state, won?, payoutXnt?, roll?, verified?, signature? }.
     */
    async waitBet(bet, { timeoutMs = 15 * 60_000, pollMs = 3_000, refund = true } = {}) {
      await this.requireV3('waitBet', 'settle_bet_v2');
      const pk = toPk(bet);
      const start = Date.now();
      let seed = null;
      for (;;) {
        const s = await this.betStatus(pk);
        if (s.seed && s.state === 'waiting') seed = s.seed;
        if (s.state === 'unanchored') { const a = await this.anchorBet(pk).catch(() => null); if (a?.seed) seed = a.seed; else await sleep(pollMs); continue; }
        if (s.state === 'closed') return this.settledBetResult(pk, seed);
        if (s.state === 'refundable') {
          if (!refund) return s;
          const signature = await this.refundStalledBet(pk);
          return { state: 'refunded', reason: s.reason, signature, note: STALL_NOTES[s.reason] ?? STALL_NOTES[0] };
        }
        if (Date.now() - start > timeoutMs) return { ...s, state: 'pending', note: 'still waiting for the keeper\'s reveal; call waitBet again later' };
        await sleep(pollMs);
      }
    },
    /** The settle of a closed keeper bet, read from its last transaction: BetSettled / BetRefunded, and the roll check. */
    async settledBetResult(bet, mixedSeedHex = null) {
      const pk = toPk(bet);
      const sigs = await this.connection.getSignaturesForAddress(pk, { limit: 20 }).catch(() => []);
      const parser = new anchor.EventParser(this.program.programId, new anchor.BorshCoder(this.program.idl));
      for (const s of sigs) {
        if (s.err) continue;
        const t = await this.connection.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
        if (!t?.meta) continue;
        for (const e of parser.parseLogs(t.meta.logMessages ?? [], false)) {
          const name = e.name.charAt(0).toUpperCase() + e.name.slice(1);
          if (name === 'BetSettled' && toPk(e.data.bet).equals(pk)) {
            let verified = null;
            const reveal = revealOf(t, this.program.programId, ixDiscriminatorHex(idlOf(this), 'settle_bet_v2'));
            if (reveal && mixedSeedHex) verified = rollFor(reveal, pk, mixedSeedHex) === Number(e.data.roll.toString());
            // G-2 (round 4): the settle tip the registered keeper wallet received from the free reward pool (never from the
            // player or the bankroll); absent from a settle by the live binary's legacy settle_bet
            const tip = e.data.keeperTip ?? e.data.keeper_tip;
            return {
              state: 'settled', won: !!e.data.won, payoutXnt: e.data.won ? Number(e.data.payout) / XNT : 0, roll: Number(e.data.roll.toString()), verified, reveal,
              keeperTipXnt: tip === undefined || tip === null ? null : Number(tip.toString()) / XNT, signature: s.signature,
            };
          }
          if (name === 'BetRefunded' && toPk(e.data.bet).equals(pk)) {
            const reason = Number(e.data.reason);
            // round 4 / r4-fix: for a house stall `penalty` is stake - edge: on reason 1 the part of the stake the bankroll kept
            // (booked as a lost bet, the payout paid from the keeper bond), on reason 0 what the bond forfeited to nobody (the
            // whole stake came back: stake - edge from the bankroll, the edge from the bond)
            return {
              state: 'refunded', reason, refundedXnt: Number(e.data.stake) / XNT,
              ...(reason === 1 ? { bankrollKeptXnt: Number(e.data.penalty) / XNT, paidFrom: 'keeper bond' } : {}),
              ...(reason === 0 ? { bankrollKeptXnt: 0, bondForfeitXnt: Number(e.data.penalty) / XNT, paidFrom: 'bankroll (stake - edge) and keeper bond (edge)' } : {}),
              note: STALL_NOTES[reason] ?? null, signature: s.signature,
            };
          }
        }
      }
      return { state: 'closed', note: 'the settle transaction was not found in the last 20 transactions of the bet account' };
    },
    /**
     * Refunds a stalled keeper bet (permissionless): never anchored → the whole stake; anchored and stalled, or skipped →
     * paid as a win. Both from the keeper bond (round 4); the reward vault is passed read-only (no stall pays the pool).
     */
    async refundStalledBet(bet) {
      await this.requireV3('refundStalledBet', 'refund_stalled_bet');
      const pk = toPk(bet);
      const b = await this.acc.bet.fetch(pk);
      return this.send(this.program.methods.refundStalledBet().accountsPartial({
        config: PDA.config(), bet: pk, playerState: b.playerState, bankrollVault: PDA.bankrollVault(), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
        rentPayer: b.rentPayer, keeperSeat: PDA.houseKeeper(), rewardVault: PDA.rewardVault(),
      }), 'refundStalledBet');
    },

    // ─── sealed Artifact Duel ─────────────────────────────────────────────────
    /** Open duels other wallets created (joinable sealed offers). */
    async openDuels() {
      const all = await this.acc.duel.all([{ memcmp: { offset: accountFieldOffset(idlOf(this), 'Duel', 'state'), bytes: '1' } }]).catch(async () => (await this.acc.duel.all()).filter((d) => d.account.state === DUEL_STATE.OPEN));
      return all.filter((d) => d.account.state === DUEL_STATE.OPEN && !toPk(d.account.creator).equals(this.me));
    },
    /** Duels this wallet created or joined. */
    async myDuels() {
      const [a, b] = await Promise.all([
        this.acc.duel.all([{ memcmp: { offset: accountFieldOffset(idlOf(this), 'Duel', 'creator'), bytes: this.me.toBase58() } }]),
        this.acc.duel.all([{ memcmp: { offset: accountFieldOffset(idlOf(this), 'Duel', 'opponent'), bytes: this.me.toBase58() } }]),
      ]);
      return [...a, ...b];
    },
    /**
     * Creates a sealed duel: stakes `stakeXnt` from the game wallet and commits keccak("MOONFORGE_DUEL" ‖ element ‖ salt ‖ duel).
     * The element and salt are written to the secrets store first. No Artifact is needed. Returns { duel, signature, sealed: true }:
     * the element is never returned (never print, log or post it); it is in mf.secrets.get('duel-create', duel).
     */
    async createDuelSealed(stakeXnt, element = 'random') {
      await this.requireV3('createDuelSealed', 'join_duel_sealed');
      const stake = lamports(stakeXnt);
      if (stake < V3.DUEL_MIN_STAKE) throw new Error('createDuelSealed: the minimum stake is 0.1 XNT. Nothing was sent.');
      const ps = await this.ensurePlayer();
      const { nonce } = await this.acc.playerState.fetch(ps);
      const duel = PDA.duel(this.me, BigInt(nonce.toString()));
      const { record } = this.secrets.getOrCreate('duel-create', duel.toBase58(), () => ({ element: pickElement(element), salt: randomHex32() }));
      const commitment = duelCommitment(record.element, record.salt, duel);
      const signature = await this.send(this.program.methods.createDuel(bn(stake), Array.from(commitment)).accountsPartial({
        config: PDA.config(), creatorState: ps, duel, owner: this.me, asset: SystemProgram.programId, record: SystemProgram.programId, collection: SystemProgram.programId, systemProgram: SystemProgram.programId,
      }), 'createDuel', { needLamports: BigInt(await this.rentFor('duel')) });
      this.secrets.annotate('duel-create', duel.toBase58(), { tx: signature });
      // the element stays in the secrets store only (mf.secrets.get('duel-create', duel)): a tool result is often logged
      // or echoed into a chat, and anyone who saw it before the duel is joined could pick the element that beats it
      return { duel, signature, sealed: true };
    },
    /**
     * Joins an open duel sealed: matches the stake and commits keccak("MOONFORGE_DUEL_JOIN" ‖ element ‖ salt ‖ duel ‖ you)
     * (secret written first), then opens it (revealDuelJoin) once the join has landed. A joiner that never opens loses its
     * stake to the reward pool; the creator then has about an hour to reveal or lose. Returns { duel, signature, opened, sealed }
     * and the element only once it is opened on chain.
     */
    async joinDuelSealed(duel, element = 'random', { open = true } = {}) {
      await this.requireV3('joinDuelSealed', 'join_duel_sealed');
      const pk = toPk(duel);
      const d = await this.acc.duel.fetch(pk);
      if (d.state !== DUEL_STATE.OPEN) throw new Error('joinDuelSealed: the duel is not open any more (DuelState). Nothing was sent.');
      if (toPk(d.creator).equals(this.me)) throw new Error('joinDuelSealed: you created this duel (SelfDuel). Nothing was sent.');
      const ps = await this.ensurePlayer();
      const { record } = this.secrets.getOrCreate('duel-join', pk.toBase58(), () => ({ element: pickElement(element), salt: randomHex32() }));
      const commitment = duelJoinCommitment(record.element, record.salt, pk, this.me);
      const signature = await this.send(this.program.methods.joinDuelSealed(Array.from(commitment)).accountsPartial({
        config: PDA.config(), duel: pk, opponentState: ps, opponent: this.me, asset: SystemProgram.programId, record: SystemProgram.programId, collection: SystemProgram.programId,
      }), 'joinDuelSealed', { priority: true });
      this.secrets.annotate('duel-join', pk.toBase58(), { tx: signature });
      let opened = false;
      if (open) {
        const joinedAt = await this.chainTime();
        while ((await this.chainTime()) <= joinedAt) await sleep(500);
        try { await this.revealDuelJoin(pk); opened = true; } catch (e) { this.onWarning(`joinDuelSealed: joined, not opened yet (${String(e?.message ?? e).slice(0, 120)}); call revealDuelJoin(${pk.toBase58()}) within 10 minutes`); }
      }
      // the element is in the clear on chain once opened; until then it stays in the secrets store only
      return { duel: pk, signature, opened, sealed: !opened, ...(opened ? { element: ELEMENTS[record.element] } : {}) };
    },
    /** The joiner opens its sealed element (within 10 minutes of the join, from the next second on). */
    async revealDuelJoin(duel) {
      const pk = toPk(duel);
      await this.requireV3('revealDuelJoin', 'reveal_duel_join', { proof: async () => sealedJoin(await this.acc.duel.fetchNullable(pk)) });
      const rec = this.secrets.get('duel-join', pk.toBase58());
      if (!rec) throw new Error(`revealDuelJoin: no stored secret for ${pk.toBase58()} in ${this.secrets.dir}`);
      return this.send(this.program.methods.revealDuelJoin(rec.element, b32(rec.salt)).accountsPartial({ duel: pk, opponent: this.me }), 'revealDuelJoin', { priority: true, resend: true });
    },
    /** The creator reveals its element (within about an hour of the joiner's opening) and the duel is paid out. */
    async revealDuel(duel) {
      const pk = toPk(duel);
      const rules = await this.requireLiveCall('revealDuel', null, { ix: 'reveal_duel_join', proof: async () => sealedJoin(await this.acc.duel.fetchNullable(pk)) });
      const rec = this.secrets.get('duel-create', pk.toBase58());
      if (!rec) throw new Error(`revealDuel: no stored secret for ${pk.toBase58()} in ${this.secrets.dir}`);
      const d = await this.acc.duel.fetch(pk);
      if (rules === 3 && d.opponentElement === 255) throw new Error('revealDuel: the joiner has not opened its element yet; wait for revealDuelJoin (or claim the timeout after 10 minutes). Nothing was sent.');
      const cfg = await this.config();
      return this.send(this.program.methods.revealDuel(rec.element, b32(rec.salt)).accountsPartial({
        resolve: { config: PDA.config(), duel: pk, creatorState: PDA.player(d.creator), opponentState: PDA.player(d.opponent), rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: cfg.architect, rentPayer: d.rentPayer },
        creator: this.me,
      }), 'revealDuel', { priority: true, resend: true });
    },
    /** Permissionless after the deadline: a sealed join never opened refunds the creator (joiner's stake to the pool); a creator who never revealed loses. */
    async claimDuelTimeout(duel) {
      await this.requireLiveCall('claimDuelTimeout');
      const pk = toPk(duel);
      const d = await this.acc.duel.fetch(pk);
      const cfg = await this.config();
      return this.send(this.program.methods.claimDuelTimeout().accountsPartial({
        config: PDA.config(), duel: pk, creatorState: PDA.player(d.creator), opponentState: PDA.player(d.opponent), rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: cfg.architect, rentPayer: d.rentPayer,
      }), 'claimDuelTimeout');
    },
    /** The creator cancels a duel nobody joined: the stake goes back to the game wallet. */
    async cancelDuel(duel) {
      await this.requireLiveCall('cancelDuel');
      return this.send(this.program.methods.cancelDuel().accountsPartial({ duel: toPk(duel), creatorState: PDA.player(this.me), creator: this.me }), 'cancelDuel');
    },

    // ─── sealed Moon Wars ─────────────────────────────────────────────────────
    /**
     * Creates a sealed match: stakes `stakeXnt` and commits keccak("MOONFORGE_WAR_ENTROPY" ‖ entropy ‖ war) (entropy
     * written to the secrets store first). No Artifact is needed. `moveKey`: the key that signs moves (default this wallet).
     */
    async createWarSealed(stakeXnt, { moveKey = null } = {}) {
      this.warn('wars');
      await this.requireV3('createWarSealed', 'create_war_sealed');
      const stake = lamports(stakeXnt);
      if (stake < V3.WAR_MIN_STAKE) throw new Error('createWarSealed: the minimum stake is 0.1 XNT. Nothing was sent.');
      const ps = await this.ensurePlayer();
      const { nonce } = await this.acc.playerState.fetch(ps);
      const war = PDA.war(this.me, BigInt(nonce.toString()));
      const key = moveKey ? toPk(moveKey) : this.me;
      const { record } = this.secrets.getOrCreate('war-create', war.toBase58(), () => ({ entropy: randomHex32(), moveKey: key.toBase58() }));
      const commitment = warEntropyCommitment(record.entropy, war);
      const signature = await this.send(this.program.methods.createWarSealed(bn(stake), toPk(record.moveKey), Array.from(commitment)).accountsPartial({
        config: PDA.config(), creatorState: ps, war, owner: this.me, asset: SystemProgram.programId, record: SystemProgram.programId, collection: SystemProgram.programId, systemProgram: SystemProgram.programId,
      }), 'createWarSealed', { needLamports: BigInt(await this.rentFor('war')) });
      this.secrets.annotate('war-create', war.toBase58(), { tx: signature });
      return { war, signature };
    },
    /** Joins an open sealed match: matches the stake and commits keccak("MOONFORGE_WAR_JOIN" ‖ secret ‖ war ‖ you ‖ move key). */
    async joinWarSealed(war) {
      this.warn('wars');
      await this.requireV3('joinWarSealed', 'join_war_sealed');
      const pk = toPk(war);
      const w = await this.war(pk);
      if (w.state !== 0 || !isSealedWar(w)) throw new Error('joinWarSealed: the match is not an open sealed match (WarState). Nothing was sent.');
      if (toPk(w.creator).equals(this.me)) throw new Error('joinWarSealed: you created this match (SelfDuel). Nothing was sent.');
      const ps = await this.ensurePlayer();
      const { record } = this.secrets.getOrCreate('war-join', pk.toBase58(), () => ({ secret: randomHex32(), moveKey: this.me.toBase58() }));
      const commitment = warJoinCommitment(record.secret, pk, this.me, toPk(record.moveKey));
      const signature = await this.send(this.program.methods.joinWarSealed(Array.from(commitment)).accountsPartial({
        config: PDA.config(), war: pk, opponentState: ps, opponent: this.me, asset: SystemProgram.programId, record: SystemProgram.programId, collection: SystemProgram.programId,
      }), 'joinWarSealed', { priority: true });
      this.secrets.annotate('war-join', pk.toBase58(), { tx: signature });
      return { war: pk, signature };
    },
    /**
     * Advances a sealed start: the creator seeds (seed_war, within 10 minutes of the join), then the joiner reveals
     * (reveal_war, within 2 minutes of the seed) and the match becomes ACTIVE. Does this wallet's step when it is due;
     * with { wait: true } keeps polling until the match is active, done, or the other side's window passed.
     */
    async advanceStart(war, { wait = false, pollMs = 1_000, timeoutMs = 15 * 60_000 } = {}) {
      const pk = toPk(war);
      await this.requireV3('advanceStart', 'seed_war', { proof: async () => isSealedWar(await this.war(pk)) });
      const start = Date.now();
      for (;;) {
        const w = await this.war(pk);
        if (w.state !== 1) return { state: w.state };
        const now = await this.chainTime();
        if (now > Number(w.deadline)) {
          try { await this.claimWarTimeout(pk); } catch { /* someone else claimed it */ }
          return { state: (await this.war(pk)).state, timeout: true };
        }
        if (w.turn === 0 && toPk(w.creator).equals(this.me)) {
          const rec = this.secrets.get('war-create', pk.toBase58());
          if (!rec) throw new Error(`advanceStart: no stored entropy for ${pk.toBase58()} in ${this.secrets.dir}: the match will be a draw when the seed window ends`);
          await this.send(this.program.methods.seedWar(b32(rec.entropy)).accountsPartial({ war: pk, signer: this.me }), 'seedWar', { priority: true, resend: true });
        } else if (w.turn === 1 && toPk(w.opponent).equals(this.me)) {
          const rec = this.secrets.get('war-join', pk.toBase58());
          if (!rec) throw new Error(`advanceStart: no stored secret for ${pk.toBase58()} in ${this.secrets.dir}: the creator wins when the reveal window ends`);
          await this.send(this.program.methods.revealWar(b32(rec.secret), toPk(rec.moveKey)).accountsPartial({ war: pk, signer: this.me }), 'revealWar', { priority: true, resend: true });
        } else if (!wait) return { state: w.state, waitingFor: w.turn === 0 ? 'the creator\'s seed' : 'the joiner\'s reveal', deadline: Number(w.deadline) };
        if (!wait) return { state: (await this.war(pk)).state };
        if (Date.now() - start > timeoutMs) return { state: w.state, pending: true };
        await sleep(pollMs);
      }
    },

    // ─── Be the House: statistics ─────────────────────────────────────────────
    /**
     * Be the House as the chain shows it now: the share value (conservative and unreserved), the pending-bet haircut,
     * today's breaker state (3% under the final upgrade, 10% before) and, under the final upgrade, the 15%-per-7-days
     * limit and the keeper. With `snapshots` ([{ ts, shareValue }], e.g. recorded by recordHouseSnapshot()) it adds the
     * realised change of the share value over 7 and 30 days: the bankroll's result, which can be negative. No rate is
     * projected and no payout is promised.
     */
    async houseStats({ snapshots = null } = {}) {
      const [bank, cfg, now] = await Promise.all([this.bankroll(), this.config(), this.chainTime()]);
      const shareValue = bank.totalShares > 0n ? Number(bank.conservative) / Number(bank.totalShares) : null;
      const shareValueUnreserved = bank.totalShares > 0n ? Number(bank.unreserved) / Number(bank.totalShares) : null;
      const dayStart = BigInt(cfg.bankrollDayStart.toString());
      const dayLossBps = dayStart > 0n && dayStart > bank.conservative ? Number(((dayStart - bank.conservative) * 10_000n) / dayStart) : 0;
      const dailyLimitBps = this.rules === 3 ? Number(V3.MAX_DAILY_LOSS_BPS) : 1_000;
      const out = {
        rules: this.rules, unreservedXnt: Number(bank.unreserved) / XNT, reservedXnt: Number(bank.reserved) / XNT, haircutPct: bank.haircutBps / 100,
        shareValueXnt: shareValue, shareValueUnreservedXnt: shareValueUnreserved, totalShares: bank.totalShares.toString(), protocolShares: bank.protocolShares.toString(),
        breaker: { day: Number(cfg.bankrollDay.toString()), dayStartXnt: Number(dayStart) / XNT, lossTodayPct: dayLossBps / 100, limitPct: dailyLimitBps / 100, tripped: dayLossBps >= dailyLimitBps },
        text: 'You share the bankroll\'s result: the share value rises when players lose and falls when they win; you can lose part of your deposit; no payout is promised and it is not a pooled investment.',
      };
      if (this.rules === 3) {
        const k = await this.acc.houseKeeper?.fetchNullable(PDA.houseKeeper()).catch(() => null);
        out.keeper = keeperView(k ?? null, now);
        if (k) {
          const base = BigInt(k.weekStartBankroll.toString()), loss = BigInt(k.weekNetLoss.toString());
          out.week = { startTs: Number(k.weekStartTs.toString()), startBankrollXnt: Number(base) / XNT, netLossXnt: Number(loss) / XNT, limitPct: Number(V3.MAX_WEEKLY_LOSS_BPS) / 100, lossPct: base > 0n && loss > 0n ? Number((loss * 10_000n) / base) / 100 : 0 };
        }
      }
      if (Array.isArray(snapshots) && shareValue !== null) {
        const at = (days) => [...snapshots].filter((s) => s.ts <= now - days * 86_400).sort((a, b) => b.ts - a.ts)[0] ?? null;
        const change = (s) => (s && s.shareValue > 0 ? Math.round(((shareValue - s.shareValue) / s.shareValue) * 10_000) / 100 : null);
        out.result = { change7dPct: change(at(7)), change30dPct: change(at(30)), note: 'realised change of the share value (the bankroll\'s result), not a rate and not a projection' };
      }
      return out;
    },
    /** Appends today's share value to a local JSON file ([{ ts, shareValue }]) for houseStats({ snapshots }). */
    async recordHouseSnapshot(file) {
      const fs = await import('node:fs');
      const s = await this.houseStats();
      let list = [];
      try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { list = []; }
      if (!Array.isArray(list)) list = [];
      list.push({ ts: await this.chainTime(), shareValue: s.shareValueXnt });
      fs.writeFileSync(file, JSON.stringify(list.slice(-400)));
      return list.length;
    },
    /** The keeper's reveal chain check, for a reveal seen in a settle: keccak(reveal) == the head it replaced. */
    revealFollows(tipHex, revealHex) { return chainNextOk(tipHex, revealHex); },
    noticesV3() { return NOTICES_V3; },
  };
  for (const [k, v] of Object.entries(methods)) Object.defineProperty(Cls.prototype, k, { value: v, writable: true, configurable: true });
}

/** The 32-byte reveal of the settle_bet_v2 instruction of a transaction (instruction data = 8-byte discriminator + reveal). */
function revealOf(tx, programId, DISC) {
  // DISC: settle_bet_v2's discriminator, read from the IDL in use (idl.mjs ixDiscriminatorHex), never hard-coded
  const msg = tx?.transaction?.message;
  if (!msg || !DISC) return null;
  const keys = (msg.staticAccountKeys ?? msg.accountKeys ?? []).map((k) => toPk(k));
  const ixs = msg.compiledInstructions ?? msg.instructions ?? [];
  for (const ix of ixs) {
    const pid = keys[ix.programIdIndex];
    if (!pid || !pid.equals(programId)) continue;
    const data = Buffer.from(typeof ix.data === 'string' ? bs58.decode(ix.data) : ix.data);
    if (data.length === 40 && data.subarray(0, 8).toString('hex') === DISC) return data.subarray(8).toString('hex');
  }
  return null;
}
