/**
 * Moon Forge agent kit — what an autonomous agent needs to play on Moon Forge (X1) with its own keypair.
 *
 *   import { connect, loadKeypair } from './moonforge.mjs';
 *   const mf = await connect({ keypair: loadKeypair(process.env.AGENT_KEY) });
 *   console.log(await mf.status());
 *
 * Covers: game wallet, Lunar Dust Artifact (the arena ticket), Moon Wars (player vs player, perfect information,
 * every move validated on-chain), daily Predictions (XNT up/down, priced by the XDEX on-chain TWAP), Be the House
 * (backing the game bankroll: deposit, 24 h withdrawal request, withdraw) and the house games (Coin Flip, High-Low,
 * Void Rush: a fixed 2% edge, so negative expected value: useful to test, never to earn). Everything goes through the
 * open-source Moon Forge program; the kit holds no keys
 * other than the one you pass and sends nothing anywhere else.
 *
 * Program: 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 (X1 mainnet). Rules and source: https://github.com/xen-moon-forge-protocol/Moon-Forge
 */
import anchor from '@coral-xyz/anchor'; // CommonJS package: the default import is the whole module (BN, Program, Wallet...)
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY } from '@solana/web3.js';
import bs58 from 'bs58';
import crypto from 'crypto';
import fs from 'fs';

export const PROGRAM_ID = new PublicKey('57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9');
export const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
/** XDEX WXNT/USDC.X observation account: the price source of Predictions (checked by the program). */
export const XDEX_OBSERVATION = new PublicKey('4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ');
export const MAINNET_RPC = 'https://rpc.mainnet.x1.xyz';
export const XNT = 1_000_000_000;
/** Lunar Dust (tier 0) price: fixed at 10 XNT; half of it stays inside the NFT as a refundable floor. */
export const LUNAR_DUST_PRICE = 10n * BigInt(XNT);

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const seed = (s) => Buffer.from(s);
const pda = (...s) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];
export const PDA = {
  config: () => pda(seed('config')),
  rewardVault: () => pda(seed('reward_vault')),
  bankrollVault: () => pda(seed('bankroll_vault')),
  drawVault: () => pda(seed('draw_vault')),
  collection: () => pda(seed('collection')),
  artifactAuthority: () => pda(seed('artifact_authority')),
  player: (owner) => pda(seed('player'), owner.toBuffer()),
  house: (owner) => pda(seed('house'), owner.toBuffer()),
  bet: (playerState, nonce) => pda(seed('bet'), playerState.toBuffer(), u64(nonce)),
  asset: (tier, serial) => pda(seed('asset'), Buffer.from([tier]), u32(serial)),
  artifact: (asset) => pda(seed('artifact'), asset.toBuffer()),
  war: (creator, nonce) => pda(seed('war'), creator.toBuffer(), u64(nonce)),
  pred: (round) => pda(seed('pred'), u64(round)),
  predEntry: (round, player) => pda(seed('pred_entry'), u64(round), player.toBuffer()),
};

/** Moon Wars rules, identical to the program (constants.rs WAR_*). Cards: [power, defense, cost]. */
export const WAR = {
  cards: [[2, 2, 1], [4, 3, 2], [6, 4, 3], [10, 10, 5]],
  names: ['Lunar Dust', 'Cosmic Shard', 'Solar Core', 'Void Anomaly'],
  fieldMax: 6,
  minStakeXnt: 0.1,
  state: { OPEN: 0, STARTING: 1, ACTIVE: 2, DONE: 3 },
  /** attack target that means "the enemy player" (allowed only when the enemy field is empty) */
  PLAYER: 255,
};
/**
 * House games (constants.rs GAME_*). Coin Flip: param 0, choice 0 | 1. High-Low: param = win chance in bps,
 * choice 0 low | 1 high. Void Rush: param = target multiplier in bps (20000 = 2x). Minimum stake 0.01 XNT; the net
 * win of one bet can be at most 0.25% of the free bankroll.
 */
export const GAME = { COINFLIP: 0, HIGHLOW: 1, VOIDRUSH: 2 };
export const PRED = {
  state: { OPEN: 0, LOCKED: 1, SETTLED: 2, REFUND: 3 },
  side: { DOWN: 0, UP: 1 },
  /** mainnet schedule: a round per UTC day, entries for the first 12 h, resolved 24 h after the lock */
  periodSeconds: 86_400,
  betWindowSeconds: 43_200,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bn = (n) => new anchor.BN(n.toString());
const lamports = (xnt) => BigInt(Math.round(xnt * XNT));

/** A keypair from a JSON array file path, a JSON array string, a base58 secret, or a byte array. */
export function loadKeypair(source) {
  if (source instanceof Keypair) return source;
  if (Array.isArray(source) || source instanceof Uint8Array) return Keypair.fromSecretKey(Uint8Array.from(source));
  if (typeof source !== 'string' || !source.trim()) throw new Error('loadKeypair: pass a keypair file path, JSON array or base58 secret');
  const s = source.trim();
  if (s.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
  if (fs.existsSync(s)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(s, 'utf8'))));
  return Keypair.fromSecretKey(bs58.decode(s));
}

/** Connects with the agent's keypair. `idl` (object or file path) is optional: by default it is read from chain. */
export async function connect({ rpc = MAINNET_RPC, keypair, idl, pred } = {}) {
  if (!keypair) throw new Error('connect: keypair is required');
  const connection = new Connection(rpc, 'confirmed');
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keypair), { commitment: 'confirmed' });
  const theIdl = idl ? (typeof idl === 'string' ? JSON.parse(fs.readFileSync(idl, 'utf8')) : idl) : await anchor.Program.fetchIdl(PROGRAM_ID, provider);
  if (!theIdl) throw new Error('could not load the Moon Forge IDL (pass `idl`)');
  return new MoonForge(new anchor.Program(theIdl, provider), keypair, { ...PRED, ...(pred ?? {}) });
}

export class MoonForge {
  constructor(program, keypair, pred) {
    this.program = program;
    this.connection = program.provider.connection;
    this.keypair = keypair;
    this.me = keypair.publicKey;
    this.acc = program.account;
    this.pred = pred;
  }

  // ─── reading ───────────────────────────────────────────────────────────────
  config() { return this.acc.config.fetch(PDA.config()); }

  async chainTime() { return (await this.connection.getBlockTime(await this.connection.getSlot('confirmed'))) ?? Math.floor(Date.now() / 1000); }

  /** USD per XNT: the 15-minute TWAP the XDEX WXNT/USDC.X pool records on-chain (token 0 = WXNT 9 dp, token 1 = USDC.X 6 dp). */
  async xntUsd(window = 900) {
    const info = await this.connection.getAccountInfo(XDEX_OBSERVATION, 'confirmed');
    if (!info || info.data.length < 43 + 100 * 40) return null;
    const d = info.data, obs = [];
    for (let i = 0; i < 100; i++) {
      const o = 43 + i * 40, ts = Number(d.readBigUInt64LE(o));
      if (ts) obs.push({ ts, cum: d.readBigUInt64LE(o + 8) | (d.readBigUInt64LE(o + 16) << 64n) });
    }
    if (obs.length < 2) return null;
    obs.sort((a, b) => a.ts - b.ts);
    const hi = obs[obs.length - 1], lo = [...obs].reverse().find((x) => x.ts <= hi.ts - window) ?? obs[0];
    if (hi.ts <= lo.ts) return null;
    return (Number((hi.cum - lo.cum) / BigInt(hi.ts - lo.ts)) / 2 ** 32) * 1e3;
  }

  /** One call with what an agent needs to decide: balances, pool, open matches, the current prediction round. */
  async status() {
    const [cfg, xnt, game, pool, arts, wars, price] = await Promise.all([
      this.config(), this.connection.getBalance(this.me), this.gameBalance(), this.connection.getAccountInfo(PDA.rewardVault()),
      this.myArtifacts(), this.openWars(), this.xntUsd(),
    ]);
    const rent = pool ? await this.connection.getMinimumBalanceForRentExemption(pool.data.length) : 0;
    const free = Math.max(0, (pool?.lamports ?? 0) - rent - Number(cfg.rewardReserved));
    const now = await this.chainTime();
    const round = this.roundId(now);
    return {
      wallet: this.me.toBase58(),
      walletXnt: xnt / XNT,
      gameBalanceXnt: Number(game) / XNT,
      artifacts: arts.length,
      xntUsd: price,
      rewardPoolXnt: free / XNT,
      weeklyBudgetXnt: Math.floor(free * 0.1) / XNT,
      openWars: wars.map((w) => ({ war: w.publicKey.toBase58(), creator: w.account.creator.toBase58(), stakeXnt: Number(w.account.stake) / XNT })),
      prediction: { round, entriesOpen: now < round * this.pred.periodSeconds + this.pred.betWindowSeconds, closesAt: round * this.pred.periodSeconds + this.pred.betWindowSeconds },
    };
  }

  // ─── game wallet ───────────────────────────────────────────────────────────
  async ensurePlayer() {
    const ps = PDA.player(this.me);
    if (await this.connection.getAccountInfo(ps)) return ps;
    await this.program.methods.openPlayer().accountsPartial({ playerState: ps, owner: this.me, systemProgram: SystemProgram.programId }).rpc();
    return ps;
  }
  async gameBalance() {
    const p = await this.acc.playerState.fetchNullable(PDA.player(this.me));
    return p ? BigInt(p.balance.toString()) : 0n;
  }
  async deposit(xnt) {
    const ps = await this.ensurePlayer();
    return this.program.methods.deposit(bn(lamports(xnt))).accountsPartial({ playerState: ps, payer: this.me, systemProgram: SystemProgram.programId }).rpc();
  }
  async withdraw(xnt) {
    return this.program.methods.withdraw(bn(lamports(xnt))).accountsPartial({ playerState: PDA.player(this.me), owner: this.me }).rpc();
  }

  // ─── house games (fixed 2% edge: negative expected value) ──────────────────
  /**
   * Places a bet from the game wallet and returns the bet account. See GAME for game / param / choice.
   * The outcome comes from the hash of a future slot: call settleBet right away (a bet nobody settles within
   * ~3 minutes counts as lost).
   */
  async placeBet(game, param, choice, stakeXnt) {
    const ps = await this.ensurePlayer();
    const { nonce } = await this.acc.playerState.fetch(ps);
    const bet = PDA.bet(ps, BigInt(nonce.toString()));
    const cfg = await this.config();
    await this.program.methods.placeBet(game, bn(param), choice, bn(lamports(stakeXnt)), Array.from(crypto.randomBytes(32))).accountsPartial({
      config: PDA.config(), playerState: ps, bet, bankrollVault: PDA.bankrollVault(), rewardVault: PDA.rewardVault(),
      architect: cfg.architect, signer: this.me, systemProgram: SystemProgram.programId,
    }).rpc();
    return bet;
  }
  /** Settles a bet once its target slot has passed (anyone may; the bet rent goes back to whoever paid it). */
  async settleBet(bet) {
    const b = await this.acc.bet.fetch(bet);
    const target = BigInt(b.targetSlot.toString());
    while (BigInt(await this.connection.getSlot('confirmed')) <= target) await sleep(400);
    const before = await this.gameBalance();
    await this.program.methods.settleBet().accountsPartial({
      config: PDA.config(), bet, playerState: b.playerState, bankrollVault: PDA.bankrollVault(),
      slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: b.rentPayer,
    }).rpc();
    const paid = (await this.gameBalance()) - before;
    return { won: paid > 0n, payoutXnt: Number(paid) / XNT };
  }

  // ─── Artifacts (any live one is the Moon Wars / Artifact Duel ticket) ──────
  async myArtifacts() {
    const records = await this.acc.artifactRecord.all();
    if (!records.length) return [];
    const infos = await this.connection.getMultipleAccountsInfo(records.map((r) => r.account.asset));
    const collection = PDA.collection();
    return records.filter((r, i) => {
      const d = infos[i]?.data;
      return infos[i] && infos[i].owner.equals(MPL_CORE) && d[0] === 1 && d[33] === 2
        && new PublicKey(d.subarray(34, 66)).equals(collection) && new PublicKey(d.subarray(1, 33)).equals(this.me);
    }).map((r) => ({ asset: r.account.asset, tier: r.account.tier, backingXnt: Number(r.account.backing) / XNT }));
  }
  /** Forges a Lunar Dust (tier 0): 50% of the price stays inside as a floor you get back by recycling it. */
  async forgeLunarDust() {
    const cfg = await this.config();
    const serial = cfg.artifactsMinted[0];
    const asset = PDA.asset(0, serial);
    // Lunar Dust has a fixed price (only the rarer tiers are dynamic); max_price protects against any change
    await this.program.methods.forgeArtifact(0, serial, bn(LUNAR_DUST_PRICE)).accountsPartial({
      config: PDA.config(), asset, record: PDA.artifact(asset), collection: PDA.collection(), artifactAuthority: PDA.artifactAuthority(),
      rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: cfg.architect, buyer: this.me, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
    }).rpc();
    return asset;
  }
  async ticket() { return (await this.myArtifacts())[0]?.asset ?? null; }

  // ─── Moon Wars ─────────────────────────────────────────────────────────────
  war(war) { return this.acc.war.fetch(war); }
  async openWars() {
    const all = await this.acc.war.all([{ memcmp: { offset: 88, bytes: bs58.encode(Buffer.from([WAR.state.OPEN])) } }]);
    return all.filter((w) => !w.account.creator.equals(this.me));
  }
  async myWars() {
    const [a, b] = await Promise.all([
      this.acc.war.all([{ memcmp: { offset: 8, bytes: this.me.toBase58() } }]),
      this.acc.war.all([{ memcmp: { offset: 40, bytes: this.me.toBase58() } }]),
    ]);
    return [...a, ...b];
  }
  async createWar(stakeXnt) {
    const ticket = await this.ticket();
    if (!ticket) throw new Error('an Artifact is the arena ticket: forge a Lunar Dust first');
    const ps = await this.ensurePlayer();
    const nonce = (await this.acc.playerState.fetch(ps)).nonce;
    const war = PDA.war(this.me, nonce);
    await this.program.methods.createWar(bn(lamports(stakeXnt)), this.me).accountsPartial({
      config: PDA.config(), creatorState: ps, war, owner: this.me, asset: ticket, record: PDA.artifact(ticket), collection: PDA.collection(), systemProgram: SystemProgram.programId,
    }).rpc();
    return war;
  }
  async joinWar(war) {
    const ticket = await this.ticket();
    if (!ticket) throw new Error('an Artifact is the arena ticket: forge a Lunar Dust first');
    const ps = await this.ensurePlayer();
    return this.program.methods.joinWar(this.me).accountsPartial({
      config: PDA.config(), war, opponentState: ps, opponent: this.me, asset: ticket, record: PDA.artifact(ticket), collection: PDA.collection(),
    }).rpc();
  }
  async cancelWar(war) {
    return this.program.methods.cancelWar().accountsPartial({ war, creatorState: PDA.player(this.me), creator: this.me }).rpc();
  }
  /** Permissionless: shuffles both decks with the hash of the block committed at join (retries until it exists). */
  async startWar(war) {
    let last = '';
    for (let i = 0; i < 40; i++) {
      const w = await this.war(war);
      if (w.state !== WAR.state.STARTING) return;
      try {
        await this.program.methods.startWar().accountsPartial({ war, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).rpc();
      } catch (e) {
        // NotReady: the committed block does not exist yet; any other failure is usually the opponent having
        // started it a moment earlier. The state is re-read on the next pass either way.
        last = String(e).slice(0, 200);
      }
      await sleep(800);
    }
    if ((await this.war(war)).state === WAR.state.STARTING) throw new Error(`the match did not start: ${last}`);
  }
  /** Every legal move for the side to move, in the program's terms. */
  legalMoves(w) {
    const me = w.sides[w.turn], foe = w.sides[1 - w.turn], out = [];
    for (let i = 0; i < me.handLen; i++) if (WAR.cards[me.hand[i]][2] <= me.mana && me.fieldLen < WAR.fieldMax) out.push({ type: 'summon', hand: i });
    for (let a = 0; a < me.fieldLen; a++) {
      if (!me.field[a].ready) continue;
      if (foe.fieldLen === 0) out.push({ type: 'attack', attacker: a, target: WAR.PLAYER });
      for (let t = 0; t < foe.fieldLen; t++) out.push({ type: 'attack', attacker: a, target: t });
    }
    out.push({ type: 'end' });
    return out;
  }
  /**
   * A simple, decent policy: hit the player when the way is clear; take trades that kill a unit without losing
   * the attacker; summon the most expensive affordable card; otherwise end the turn. Replace it with your own.
   */
  greedyMove(w) {
    const me = w.sides[w.turn], foe = w.sides[1 - w.turn], moves = this.legalMoves(w);
    const face = moves.find((m) => m.type === 'attack' && m.target === WAR.PLAYER);
    if (face) return face;
    let best = null, bestScore = 0;
    for (const m of moves.filter((x) => x.type === 'attack')) {
      const atk = me.field[m.attacker], def = foe.field[m.target];
      const [ap] = WAR.cards[atk.element], [dp] = WAR.cards[def.element];
      const kills = def.defense - ap <= 0, survives = atk.defense - dp > 0;
      const score = (kills ? WAR.cards[def.element][2] * 2 : 0) + (survives ? 1 : -WAR.cards[atk.element][2]);
      if (kills && score > bestScore) { best = m; bestScore = score; }
    }
    if (best) return best;
    const summons = moves.filter((x) => x.type === 'summon').sort((a, b) => WAR.cards[me.hand[b.hand]][2] - WAR.cards[me.hand[a.hand]][2]);
    if (summons.length) return summons[0];
    return { type: 'end' };
  }
  async move(war, m) {
    const b = m.type === 'summon' ? this.program.methods.warSummon(m.hand)
      : m.type === 'attack' ? this.program.methods.warAttack(m.attacker, m.target)
        : this.program.methods.warEndTurn();
    return b.accountsPartial({ war, signer: this.me }).rpc();
  }
  /**
   * Plays a joined match to the end with `policy` (default greedyMove). Moves only on this agent's turns; claims the
   * win if the opponent runs out of time. Returns the finished match account. Turn timer: 2 minutes on mainnet.
   */
  async playMatch(war, { policy, log = () => {}, pollMs = 1500 } = {}) {
    const choose = policy ?? ((w) => this.greedyMove(w));
    await this.startWar(war);
    let failures = 0;
    for (;;) {
      const w = await this.war(war);
      if (w.state === WAR.state.DONE) return w;
      const mine = (w.turn === 0 ? w.creator : w.opponent).equals(this.me);
      const now = await this.chainTime();
      if (!mine) {
        if (now > Number(w.deadline)) {
          try { await this.program.methods.claimWarTimeout().accountsPartial({ war }).rpc(); log('opponent ran out of time'); } catch { /* raced */ }
        }
        await sleep(pollMs);
        continue;
      }
      const m = choose(w);
      try {
        await this.move(war, m);
        failures = 0;
        log(`round ${w.round}: ${m.type}${m.type === 'summon' ? ` ${WAR.names[w.sides[w.turn].hand[m.hand]]}` : m.type === 'attack' ? ` ${m.attacker}→${m.target === WAR.PLAYER ? 'player' : m.target}` : ''}`);
      } catch (e) {
        // the state may have moved on (match over, turn timed out, an RPC that dropped the error details):
        // re-read it and try again; give up only on a move that keeps failing on the same state
        if (++failures >= 5) throw new Error(`move keeps failing: ${String(e).slice(0, 200)}`);
        await sleep(pollMs);
      }
    }
  }
  /** Permissionless once finished: winner gets both stakes minus the 2% rake (1% to the burners' pool); a draw refunds both. */
  async settleWar(war) {
    const w = await this.war(war);
    const cfg = await this.config();
    return this.program.methods.settleWar().accountsPartial({
      config: PDA.config(), war, creatorState: PDA.player(w.creator), opponentState: PDA.player(w.opponent), rewardVault: PDA.rewardVault(),
      drawVault: PDA.drawVault(), architect: cfg.architect, rentPayer: w.rentPayer,
    }).rpc();
  }

  // ─── Predictions ───────────────────────────────────────────────────────────
  roundId(now) { return Math.floor(now / this.pred.periodSeconds); }
  /** Enters the current round (wallet owner only, one entry per round), stake from the game wallet. side: 'up' | 'down'. */
  async enterPrediction(side, xnt) {
    const ps = await this.ensurePlayer();
    const id = this.roundId(await this.chainTime());
    await this.program.methods.enterPrediction(bn(id), side === 'up' ? PRED.side.UP : PRED.side.DOWN, bn(lamports(xnt))).accountsPartial({
      round: PDA.pred(id), entry: PDA.predEntry(id, this.me), playerState: ps, owner: this.me, systemProgram: SystemProgram.programId,
    }).rpc();
    return id;
  }
  async myPredictionEntries() {
    return this.acc.predEntry.all([{ memcmp: { offset: 16, bytes: this.me.toBase58() } }]);
  }
  /** Permissionless: locks a round after its entry window, or settles it after its end time. */
  async advancePrediction(id) {
    const r = await this.acc.predRound.fetch(PDA.pred(id));
    if (r.state === PRED.state.OPEN) return this.program.methods.lockPrediction().accountsPartial({ round: PDA.pred(id), observation: XDEX_OBSERVATION }).rpc();
    const cfg = await this.config();
    return this.program.methods.settlePrediction().accountsPartial({
      config: PDA.config(), round: PDA.pred(id), observation: XDEX_OBSERVATION, rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: cfg.architect,
    }).rpc();
  }
  /** Claims every resolved entry of this agent (winners share the pot pro-rata minus 2%; refunds return the stake). */
  async claimPredictions() {
    const out = [];
    for (const e of await this.myPredictionEntries()) {
      const id = Number(e.account.round);
      const r = await this.acc.predRound.fetch(PDA.pred(id));
      if (r.state !== PRED.state.SETTLED && r.state !== PRED.state.REFUND) continue;
      await this.program.methods.claimPrediction().accountsPartial({
        config: PDA.config(), round: PDA.pred(id), entry: e.publicKey, playerState: PDA.player(e.account.player), rentPayer: e.account.rentPayer,
      }).rpc();
      out.push(id);
    }
    return out;
  }

  // ─── Be the House ──────────────────────────────────────────────────────────
  /** Shares a deposit of `xnt` would mint now (deposits are priced as if every pending bet loses). */
  async houseQuote(xnt) {
    const cfg = await this.config();
    const info = await this.connection.getAccountInfo(PDA.bankrollVault());
    const rent = info ? await this.connection.getMinimumBalanceForRentExemption(info.data.length) : 0;
    const optimistic = BigInt(Math.max(0, (info?.lamports ?? 0) - rent));
    const value = optimistic > 1_000_000n ? optimistic : 1_000_000n;
    const total = BigInt(cfg.houseTotalShares.toString()) === 0n ? value : BigInt(cfg.houseTotalShares.toString());
    return (lamports(xnt) * total) / value;
  }
  /** Backs the bankroll: you share its result (0.5% of every house stake stays in it; it pays the winners). 24 h withdrawal cooldown. */
  async houseDeposit(xnt, slippageBps = 100) {
    const minShares = ((await this.houseQuote(xnt)) * BigInt(10_000 - slippageBps)) / 10_000n;
    return this.program.methods.houseDeposit(bn(lamports(xnt)), bn(minShares)).accountsPartial({
      config: PDA.config(), share: PDA.house(this.me), bankrollVault: PDA.bankrollVault(), owner: this.me, systemProgram: SystemProgram.programId,
    }).rpc();
  }
  /** Your Be the House position: shares, shares requested for withdrawal and when they unlock (unix seconds). */
  async houseShare() {
    const s = await this.acc.houseShare.fetchNullable(PDA.house(this.me));
    return s ? { shares: BigInt(s.shares.toString()), pendingShares: BigInt(s.pendingShares.toString()), unlockTs: Number(s.unlockTs.toString()) } : null;
  }
  /** Starts the 24 h withdrawal cooldown for `shares` (default: all of them). A new request replaces the previous one. */
  async houseRequestWithdraw(shares) {
    const s = await this.houseShare();
    if (!s) throw new Error('houseRequestWithdraw: no Be the House position');
    return this.program.methods.houseRequestWithdraw(bn(shares === undefined ? s.shares : BigInt(shares))).accountsPartial({
      share: PDA.house(this.me), owner: this.me,
    }).rpc();
  }
  /** After the cooldown, pays the requested shares at the conservative share value; fails if that is below `minXnt`. */
  async houseWithdraw(minXnt = 0) {
    return this.program.methods.houseWithdraw(bn(lamports(minXnt))).accountsPartial({
      config: PDA.config(), share: PDA.house(this.me), bankrollVault: PDA.bankrollVault(), owner: this.me,
    }).rpc();
  }
}
