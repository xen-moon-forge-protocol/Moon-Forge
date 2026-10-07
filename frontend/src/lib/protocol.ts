/**
 * Moon Forge v2 — protocol client for the frontend.
 *
 * Mirrors programs/moon-forge (Rust) exactly: same PDAs, same constants, same RNG.
 * Every number shown in the UI should come from here (on-chain reads), never from mocks.
 */
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY, Transaction, VersionedTransaction } from '@solana/web3.js';
import { ethers } from 'ethers';
import { keccak_256 } from '@noble/hashes/sha3';
import idl from '../idl/moon_forge.json';

export const X1_RPC = 'https://rpc.mainnet.x1.xyz';
export const X1_EXPLORER = 'https://explorer.mainnet.x1.xyz';
export const PROGRAM_ID = new PublicKey((idl as any).address);
export const ARCHITECT = new PublicKey('7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd');
export const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
export const XNT = 1_000_000_000;

// ── Constants mirrored from programs/moon-forge/src/constants.rs ───────────
export const P = {
  epochBudgetBps: 1000,
  claimWindowDays: 90,
  minEpochIntervalDays: 6,
  tiers: [
    { id: 0, name: 'Launchpad', icon: '🚀', multiplier: 1, vestingDays: 0, penaltyPct: 0 },
    { id: 1, name: 'Orbit', icon: '🛸', multiplier: 2, vestingDays: 45, penaltyPct: 60 },
    { id: 2, name: 'Moon Landing', icon: '🌙', multiplier: 3, vestingDays: 180, penaltyPct: 75 },
  ],
  houseEdgePct: 2,
  edgeToPoolPct: 1,
  edgeToArchitectPct: 0.5,
  edgeToBankrollPct: 0.5,
  maxExposurePct: 0.25,
  minStake: 0.01,
  p2pRakePct: 2,
  rakeToPoolPct: 1,
  rakeToArchitectPct: 0.5,
  rakeToDrawPct: 0.5,
  jackpotMinutes: 10,
  duelMinStake: 0.1,
  duelRevealMinutes: 60,
  drawDays: 7,
  ticketPrice: 1,
  drawPrizePct: 50,
  houseWithdrawHours: 24,
  chipPerClaimedXnt: 1,
  chipPerWageredXnt: 10,
  keeperTip: 0.002,
  keeperTipMinClaim: 0.02,
  rateCapK: 1.25,
  // Forge Drops (drops.rs)
  dropBudgetPct: 10,
  dropBackingXnt: 5,
  maxDropsPerEpoch: 20,
  dropLuckBufferXnt: 15,
  dropKeeperTip: 0.01,
  // aggregate cap on unsettled house bets and daily circuit breaker (games.rs)
  maxTotalExposurePct: 20,
  maxDailyLossPct: 10,
};
export const DROP_BACKING = 5n * BigInt(1_000_000_000);

export const ARTIFACTS = [
  { tier: 0, name: 'Lunar Dust', slug: 'lunar_dust', element: 'Lunar', supply: 600, price: 10, boostPct: 5, weeklyChips: 5, variants: 6, color: '#c0c0d8' },
  { tier: 1, name: 'Cosmic Shard', slug: 'cosmic_shard', element: 'Cosmic', supply: 300, price: 25, boostPct: 10, weeklyChips: 15, variants: 3, color: '#9b6bff' },
  { tier: 2, name: 'Solar Core', slug: 'solar_core', element: 'Solar', supply: 90, price: 60, boostPct: 20, weeklyChips: 40, variants: 2, color: '#ff8a1f' },
  { tier: 3, name: 'Void Anomaly', slug: 'void_anomaly', element: 'Void', supply: 10, price: 200, boostPct: 50, weeklyChips: 150, variants: 1, color: '#3a1f5c' },
];
export const FORGE_SPLIT = { floorPct: 50, poolPct: 40, drawPct: 5, architectPct: 5 };
/** constants.rs dynamic price: Lunar Dust fixed; others +5% per forge, ÷1.05 per quiet week, ≥ base, ≤ 100× base. */
export const DYNAMIC_PRICE = [false, true, true, true];
export const PRICE_DECAY_SECONDS = 7 * 24 * 60 * 60;
const PRICE_CAP_MULTIPLE = 100n;
/** Exact mirror of artifacts.rs::current_price (lamports). */
export function artifactPrice(cfg: any, tier: number, now = Math.floor(Date.now() / 1000)): bigint {
  const base = BigInt(ARTIFACTS[tier].price) * BigInt(XNT);
  const stored = cfg ? BigInt(cfg.artifactPrice?.[tier]?.toString() ?? '0') : 0n;
  if (!DYNAMIC_PRICE[tier] || stored <= base) return base;
  const periods = Math.min(1000, Math.max(0, Math.floor((now - Number(cfg.artifactPriceTs[tier])) / PRICE_DECAY_SECONDS)));
  let p = stored;
  for (let i = 0; i < periods; i++) {
    p = (p * 20n) / 21n;
    if (p <= base) return base;
  }
  return p;
}
/** Exact mirror of artifacts.rs::next_price: what the next buyer pays after a forge at `paid`. */
export function nextArtifactPrice(paid: bigint, tier: number): bigint {
  if (!DYNAMIC_PRICE[tier]) return paid;
  const cap = BigInt(ARTIFACTS[tier].price) * BigInt(XNT) * PRICE_CAP_MULTIPLE;
  const n = (paid * 21n) / 20n;
  return n < cap ? n : cap;
}
export const SECONDARY_ROYALTY_PCT = 5;
export const AIRDROP_MAX = 120;
/** constants.rs::WEEK (always real seconds) — weekly Artifact chips use now / WEEK. */
export const WEEK_SECONDS = 7 * 24 * 60 * 60;
/** a beats b <=> b == (a+3)%4 : Lunar>Void, Void>Solar, Solar>Cosmic, Cosmic>Lunar */
export const beats = (a: number, b: number) => b === (a + 3) % 4;

export const GAME = { COINFLIP: 0, HIGHLOW: 1, VOIDRUSH: 2 } as const;
const RTP_NUMERATOR = 98_000_000;
/** Same math as games.rs::game_odds — returns [chanceBps, payoutBps]. */
export function gameOdds(game: number, param: number): [number, number] {
  if (game === GAME.COINFLIP) return [5000, Math.floor(RTP_NUMERATOR / 5000)];
  if (game === GAME.HIGHLOW) return [param, Math.floor(RTP_NUMERATOR / param)];
  return [Math.floor(RTP_NUMERATOR / param), param];
}
export function isWin(game: number, choice: number, chance: number, roll: number) {
  if (game === GAME.COINFLIP) return (roll < 5000) === (choice === 0);
  if (game === GAME.HIGHLOW) return choice === 0 ? roll < chance : roll >= 10000 - chance;
  return roll < chance;
}

// ── PDAs ───────────────────────────────────────────────────────────────────
const u64 = (n: number | bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const enc = (s: string) => new TextEncoder().encode(s);
const pda = (...s: Uint8Array[]) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];
export const PDA = {
  config: () => pda(enc('config')),
  rewardVault: () => pda(enc('reward_vault')),
  bankrollVault: () => pda(enc('bankroll_vault')),
  drawVault: () => pda(enc('draw_vault')),
  collection: () => pda(enc('collection')),
  artifactAuthority: () => pda(enc('artifact_authority')),
  epoch: (n: number) => pda(enc('epoch'), u64(n)),
  receipt: (n: number, p: PublicKey, t: number) => pda(enc('receipt'), u64(n), p.toBytes(), Uint8Array.of(t)),
  mission: (n: number, p: PublicKey, t: number) => pda(enc('mission'), u64(n), p.toBytes(), Uint8Array.of(t)),
  player: (o: PublicKey) => pda(enc('player'), o.toBytes()),
  bet: (ps: PublicKey, n: number | bigint) => pda(enc('bet'), ps.toBytes(), u64(n)),
  house: (o: PublicKey) => pda(enc('house'), o.toBytes()),
  jackpot: (r: number) => pda(enc('jackpot'), u64(r)),
  jpEntry: (r: number, i: number) => pda(enc('jp_entry'), u64(r), u32(i)),
  draw: (r: number) => pda(enc('draw'), u64(r)),
  drawEntry: (r: number, i: number) => pda(enc('draw_entry'), u64(r), u32(i)),
  duel: (c: PublicKey, n: number | bigint) => pda(enc('duel'), c.toBytes(), u64(n)),
  asset: (t: number, s: number) => pda(enc('asset'), Uint8Array.of(t), u32(s)),
  artifact: (a: PublicKey) => pda(enc('artifact'), a.toBytes()),
  airdrop: (c: PublicKey) => pda(enc('airdrop'), c.toBytes()),
  drop: (n: number, p: PublicKey, t: number) => pda(enc('drop'), u64(n), p.toBytes(), Uint8Array.of(t)),
};

export const keccak = (...parts: Uint8Array[]) => { const h = keccak_256.create(); parts.forEach((p) => h.update(p)); return h.digest(); };

// ── Program / wallet adapter ───────────────────────────────────────────────
export interface X1Provider {
  publicKey: PublicKey | { toString(): string };
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions?<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
}

export const readConnection = new Connection(X1_RPC, 'confirmed');

export function getProgram(provider?: X1Provider | null, connection: Connection = readConnection) {
  const pk = provider ? new PublicKey(provider.publicKey.toString()) : PublicKey.default;
  const wallet = {
    publicKey: pk,
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => {
      if (!provider) throw new Error('Connect your X1 wallet first');
      return provider.signTransaction(tx);
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) => {
      if (!provider) throw new Error('Connect your X1 wallet first');
      if (provider.signAllTransactions) return provider.signAllTransactions(txs);
      const out: T[] = [];
      for (const t of txs) out.push(await provider.signTransaction(t));
      return out;
    },
  };
  const ap = new anchor.AnchorProvider(connection, wallet as any, { commitment: 'confirmed' });
  return new anchor.Program(idl as anchor.Idl, ap);
}
const accs = (p: anchor.Program) => p.account as any;
const bn = (n: number | bigint | string) => new anchor.BN(n.toString());
export const toXnt = (lamports: number | bigint | anchor.BN | string) => Number(lamports.toString()) / XNT;
export const fromXnt = (xnt: number) => Math.round(xnt * XNT);

// ── Reads ──────────────────────────────────────────────────────────────────
export async function fetchProtocol(connection: Connection = readConnection) {
  const program = getProgram(null, connection);
  const config = await accs(program).config.fetchNullable(PDA.config());
  // Same as utils.rs::free_balance: rent is computed from each vault's ACTUAL data length.
  const infos = await connection.getMultipleAccountsInfo([PDA.rewardVault(), PDA.bankrollVault(), PDA.drawVault()]);
  const rents = await Promise.all(infos.map((i) => (i ? connection.getMinimumBalanceForRentExemption(i.data.length) : Promise.resolve(0))));
  const [reward, bankroll, draw] = infos.map((i, k) => Math.max(0, (i?.lamports ?? 0) - rents[k]));
  const rewardReserved = config ? Number(config.rewardReserved) : 0;
  const bankrollReserved = config ? Number(config.bankrollReserved) : 0;
  return {
    initialized: !!config,
    config,
    rewardTotal: reward,
    rewardFree: Math.max(0, reward - rewardReserved),
    rewardReserved,
    nextEpochBudget: Math.max(0, Math.floor((reward - rewardReserved) * 0.1)),
    /** part of the next epoch paid as Forge Drops (random Lunar Dust with a real floor) */
    nextDropReserve: Math.min(Math.floor(Math.max(0, Math.floor((reward - rewardReserved) * 0.1)) * 0.1), 20 * 5 * XNT),
    bankrollFree: Math.max(0, bankroll - bankrollReserved),
    bankrollReserved,
    drawVault: draw,
    maxNetWin: Math.floor(Math.max(0, bankroll - bankrollReserved) * 0.0025),
  };
}
export type ProtocolSnapshot = Awaited<ReturnType<typeof fetchProtocol>>;

/** Value in lamports of `shares` Be-the-House shares (same formula as games.rs::house_withdraw). */
export function houseShareValue(shares: number | bigint | string, totalShares: number | bigint | string, bankrollFree: number) {
  const t = BigInt(totalShares.toString());
  if (t === 0n) return 0;
  return Number((BigInt(shares.toString()) * BigInt(bankrollFree)) / t);
}

/** Program upgrade authority, read from the BPF upgradeable loader's ProgramData account. */
export const BPF_UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export async function fetchUpgradeAuthority(connection: Connection = readConnection) {
  const info = await connection.getAccountInfo(PROGRAM_ID);
  if (!info) throw new Error('Program account not found');
  if (!info.owner.equals(BPF_UPGRADEABLE_LOADER) || info.data.length < 36) {
    return { loader: info.owner, programData: null as PublicKey | null, authority: null as PublicKey | null, lastDeploySlot: null as number | null };
  }
  const programData = new PublicKey(info.data.subarray(4, 36));
  const pd = await connection.getAccountInfo(programData, { dataSlice: { offset: 0, length: 45 } });
  if (!pd || pd.data.length < 13) return { loader: info.owner, programData, authority: null, lastDeploySlot: null };
  const lastDeploySlot = Number(new DataView(pd.data.buffer, pd.data.byteOffset + 4, 8).getBigUint64(0, true));
  const authority = pd.data[12] === 1 && pd.data.length >= 45 ? new PublicKey(pd.data.subarray(13, 45)) : null;
  return { loader: info.owner, programData, authority, lastDeploySlot };
}

export const explorerTx = (sig: string) => `${X1_EXPLORER}/tx/${sig}`;
export const explorerAddress = (a: PublicKey | string) => `${X1_EXPLORER}/address/${a.toString()}`;

/** Human-readable message for Anchor / RPC / wallet errors. */
export function errorMessage(e: any): string {
  if (!e) return 'Unknown error';
  if (e.error?.errorMessage) return `${e.error.errorMessage}${e.error.errorCode?.code ? ` (${e.error.errorCode.code})` : ''}`;
  const logs: string[] | undefined = e.logs || e.transactionLogs;
  const anchorLine = logs?.find((l) => l.includes('Error Message:'));
  if (anchorLine) return anchorLine.split('Error Message:')[1].trim();
  if (e.shortMessage) return e.shortMessage;
  if (e.reason) return e.reason;
  if (e.code === 4001 || e.code === 'ACTION_REJECTED') return 'Request rejected in the wallet';
  // Anchor 0.32 + web3.js 1.98 lose the logs of a tx that passed the preview but failed on-chain
  if (String(e.message || '').includes("Unknown action")) {
    return 'The transaction failed on-chain because the state changed after the preview (for example a round just closed or a price moved). Only the network fee was spent; refresh and retry.';
  }
  return String(e.message || e).slice(0, 300);
}

export async function fetchPlayer(owner: PublicKey, connection: Connection = readConnection) {
  return accs(getProgram(null, connection)).playerState.fetchNullable(PDA.player(owner));
}

export async function fetchMissions(owner: PublicKey, connection: Connection = readConnection) {
  const program = getProgram(null, connection);
  return accs(program).mission.all([{ memcmp: { offset: 8, bytes: owner.toBase58() } }]);
}

export function vestedNow(m: any, now = Math.floor(Date.now() / 1000)) {
  const total = Number(m.total), start = Number(m.start), end = Number(m.end), withdrawn = Number(m.withdrawn);
  const vested = now >= end ? total : Math.floor((total * Math.max(0, now - start)) / Math.max(1, end - start));
  return { vested, withdrawable: Math.max(0, vested - withdrawn), unvested: total - vested };
}

/** Exact mirror (u64/u128 integer math) of forge.rs::eject at time `now`. Lamports. */
export function ejectPreview(m: any, now = Math.floor(Date.now() / 1000)) {
  const total = BigInt(m.total.toString()), withdrawn = BigInt(m.withdrawn.toString());
  const start = BigInt(m.start.toString()), end = BigInt(m.end.toString()), t = BigInt(now);
  const dur = end - start > 0n ? end - start : 1n;
  const el = t - start > 0n ? t - start : 0n;
  const vested = t >= end ? total : (total * el) / dur;
  const vestedUnpaid = vested > withdrawn ? vested - withdrawn : 0n;
  const unvested = total > vested ? total - vested : 0n;
  const penaltyBps = BigInt(P.tiers[Number(m.tier)]?.penaltyPct ?? 0) * 100n;
  const penalty = (unvested * penaltyBps) / 10_000n;
  const paid = vestedUnpaid + unvested - penalty;
  return { vested: Number(vested), vestedUnpaid: Number(vestedUnpaid), unvested: Number(unvested), penalty: Number(penalty), paid: Number(paid) };
}

/** Epoch files published by the oracle (GitHub Pages). */
export interface EpochIndexEntry { epoch: number; root: string; dataHash?: string; leaves: number; totalScore?: string; tx: string; createdAt: string }
export async function fetchEpochIndex(): Promise<{ programId?: string; epochs: EpochIndexEntry[] }> {
  const r = await fetch(`${import.meta.env.BASE_URL}epochs/index.json`, { cache: 'no-store' });
  if (!r.ok) return { epochs: [] };
  return r.json();
}
/** On-chain Epoch accounts (null where not published). */
export async function fetchEpochAccounts(ids: number[], connection: Connection = readConnection): Promise<(any | null)[]> {
  if (ids.length === 0) return [];
  return accs(getProgram(null, connection)).epoch.fetchMultiple(ids.map((n) => PDA.epoch(n)));
}
export async function fetchEpochFile(n: number): Promise<any> {
  const r = await fetch(`${import.meta.env.BASE_URL}epochs/epoch-${n}.json`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`epoch ${n} file not found`);
  return r.json();
}

/** Forge Drop of one leaf. state: 0 none, 1 waiting for the seed, 2 drawn, 3 cancelled (see drops.rs) */
export interface LeafDrop { state: number; won: boolean; value: number; claimed: boolean; chance: number }
export interface MyLeaf { epoch: number; tier: number; score: string; proof: string[]; claimed: boolean; expired: boolean; estimate: number; expiresAt: number; onChain: boolean; drop: LeafDrop }

/** Exact mirror of drops.rs::drop_outcome. */
export function dropOutcome(ep: any, player: PublicKey, tier: number, score: bigint): { won: boolean; value: bigint; chance: number } {
  const reserve = BigInt(ep.dropReserve.toString());
  const total = BigInt(ep.totalScore.toString());
  if (reserve === 0n || total === 0n) return { won: false, value: 0n, chance: 0 };
  const value = (score * reserve) / total;
  if (value >= DROP_BACKING) return { won: true, value, chance: 1 };
  const chance = Number(value) / Number(DROP_BACKING);
  if (Number(ep.dropState) !== 2) return { won: false, value: DROP_BACKING, chance };
  const r = rollFrom(Uint8Array.from(ep.dropSeed), player.toBytes(), Uint8Array.from([tier])) % DROP_BACKING;
  return { won: r < value, value: DROP_BACKING, chance };
}
export async function fetchMyLeaves(owner: PublicKey, connection: Connection = readConnection): Promise<MyLeaf[]> {
  const idx = await fetchEpochIndex();
  const program = getProgram(null, connection);
  const out: MyLeaf[] = [];
  const now = Math.floor(Date.now() / 1000);
  for (const e of idx.epochs.slice(-20)) {
    const f = await fetchEpochFile(e.epoch).catch(() => null);
    if (!f) continue;
    const ep = await accs(program).epoch.fetchNullable(PDA.epoch(e.epoch));
    for (const l of f.leaves.filter((x: any) => x.player === owner.toBase58())) {
      const claimed = !!(await connection.getAccountInfo(PDA.receipt(e.epoch, owner, l.tier)));
      const estimate = ep ? Number((BigInt(l.score) * BigInt(ep.budget.toString())) / BigInt(ep.totalScore.toString())) : 0;
      const expiresAt = ep ? Number(ep.expiresAt) : 0;
      // forge.rs rejects claims when the epoch is closed OR now >= expires_at (even before expire_epoch runs)
      const expired = !!ep && (ep.closed || now >= expiresAt);
      const drop: LeafDrop = { state: ep ? Number(ep.dropState) : 0, won: false, value: 0, claimed: false, chance: 0 };
      if (ep) {
        const o = dropOutcome(ep, owner, l.tier, BigInt(l.score));
        drop.won = drop.state === 2 && o.won;
        drop.value = Number(o.value);
        drop.chance = o.chance;
        drop.claimed = !!(await connection.getAccountInfo(PDA.drop(e.epoch, owner, l.tier)));
      }
      out.push({ epoch: e.epoch, tier: l.tier, score: l.score, proof: f.proofs[`${l.player}:${l.tier}`] || [], claimed, expired, estimate, expiresAt, onChain: !!ep, drop });
    }
  }
  return out;
}

export async function fetchMyArtifacts(owner: PublicKey, connection: Connection = readConnection) {
  const program = getProgram(null, connection);
  const records: any[] = await accs(program).artifactRecord.all();
  const infos = await connection.getMultipleAccountsInfo(records.map((r) => r.account.asset));
  const collection = PDA.collection();
  return records
    .map((r, i) => ({ r, info: infos[i] }))
    .filter(({ info }) => info && info.owner.equals(MPL_CORE) && info.data[0] === 1 && info.data[33] === 2
      && new PublicKey(info.data.subarray(34, 66)).equals(collection)
      && new PublicKey(info.data.subarray(1, 33)).equals(owner))
    .map(({ r }) => ({ asset: r.account.asset as PublicKey, tier: r.account.tier as number, serial: r.account.serial as number, backing: Number(r.account.backing), origin: r.account.origin as number, lastChipWeek: Number(r.account.lastChipWeek) }));
}

/** True once init_artifacts has created the Core collection (forging is impossible before). */
export async function fetchArtifactsReady(connection: Connection = readConnection) {
  return !!(await connection.getAccountInfo(PDA.collection()));
}

// ── Actions (X1) ───────────────────────────────────────────────────────────
type Prov = X1Provider;
const me = (p: Prov) => new PublicKey(p.publicKey.toString());

export async function claimLeaf(p: Prov, l: MyLeaf) {
  const program = getProgram(p);
  const player = me(p);
  const proof = l.proof.map((h) => Array.from(ethers.getBytes('0x' + h)));
  const common = {
    config: PDA.config(), epoch: PDA.epoch(l.epoch), receipt: PDA.receipt(l.epoch, player, l.tier), player,
    playerState: PDA.player(player), rewardVault: PDA.rewardVault(), payer: player, systemProgram: SystemProgram.programId,
  };
  return l.tier === 0
    ? program.methods.claimInstant(bn(l.epoch), l.tier, bn(l.score), proof).accountsPartial(common).rpc()
    : program.methods.claimMission(bn(l.epoch), l.tier, bn(l.score), proof).accountsPartial({ ...common, mission: PDA.mission(l.epoch, player, l.tier) }).rpc();
}

export async function withdrawVested(p: Prov, m: { publicKey: PublicKey; account: any }) {
  return getProgram(p).methods.withdrawVested().accountsPartial({
    mission: m.publicKey, player: m.account.player, playerState: PDA.player(m.account.player), rentPayer: m.account.rentPayer,
  }).rpc();
}

export async function eject(p: Prov, m: { publicKey: PublicKey; account: any }) {
  return getProgram(p).methods.eject().accountsPartial({
    config: PDA.config(), mission: m.publicKey, player: me(p), rewardVault: PDA.rewardVault(), rentPayer: m.account.rentPayer,
    playerState: PDA.player(me(p)),
  }).rpc();
}

export async function donate(p: Prov, target: 0 | 1 | 2, xnt: number) {
  const vault = [PDA.rewardVault(), PDA.bankrollVault(), PDA.drawVault()][target];
  return getProgram(p).methods.donate(target, bn(fromXnt(xnt))).accountsPartial({ config: PDA.config(), donor: me(p), vault }).rpc();
}

// ── WXNT (wrapped XNT, native mint So111…112 on X1) ────────────────────────
export const WXNT_MINT = new PublicKey('So11111111111111111111111111111111111111112');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/** All WXNT token accounts of `owner` and their total (lamports). */
export async function fetchWxnt(owner: PublicKey, connection: Connection = readConnection) {
  const res = await connection.getParsedTokenAccountsByOwner(owner, { mint: WXNT_MINT });
  const accounts = res.value.map((a) => ({ pubkey: a.pubkey, amount: Number((a.account.data as any).parsed.info.tokenAmount.amount) }));
  return { accounts, total: accounts.reduce((s, a) => s + a.amount, 0) };
}

/**
 * Donates ALL the wallet's WXNT in one transaction: each WXNT account is closed (SPL Token
 * CloseAccount unwraps it back to native XNT in the donor's wallet, rent included), then
 * `donate` sends exactly the unwrapped amount to the chosen vault. No program change needed.
 */
export async function donateWxnt(p: Prov, target: 0 | 1 | 2) {
  const owner = me(p);
  const { accounts, total } = await fetchWxnt(owner);
  if (total <= 0) throw new Error('No WXNT in this wallet');
  const closes = accounts.map((a) => new anchor.web3.TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: a.pubkey, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Uint8Array.of(9) as any, // CloseAccount
  }));
  const vault = [PDA.rewardVault(), PDA.bankrollVault(), PDA.drawVault()][target];
  return getProgram(p).methods.donate(target, bn(total)).accountsPartial({ config: PDA.config(), donor: owner, vault })
    .preInstructions(closes).rpc();
}

export async function ensurePlayer(p: Prov) {
  const program = getProgram(p);
  const ps = PDA.player(me(p));
  if (await program.provider.connection.getAccountInfo(ps)) return ps;
  await program.methods.openPlayer().accountsPartial({ playerState: ps, owner: me(p), systemProgram: SystemProgram.programId }).rpc();
  return ps;
}

export async function deposit(p: Prov, xnt: number) {
  const ps = await ensurePlayer(p);
  return getProgram(p).methods.deposit(bn(fromXnt(xnt))).accountsPartial({ playerState: ps, payer: me(p), systemProgram: SystemProgram.programId }).rpc();
}
export async function withdraw(p: Prov, lamports: number) {
  return getProgram(p).methods.withdraw(bn(lamports)).accountsPartial({ playerState: PDA.player(me(p)), owner: me(p) }).rpc();
}
export async function setSession(p: Prov, key: PublicKey, hours: number, maxStakeXnt: number) {
  const exp = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
  return getProgram(p).methods.setSession(key, bn(exp), bn(fromXnt(maxStakeXnt))).accountsPartial({ playerState: PDA.player(me(p)), owner: me(p) }).rpc();
}

/** Mirrors utils.rs::slot_hash_at_or_after, including the Expired case (target older than the SlotHashes window). */
export async function slotHashLookup(connection: Connection, target: bigint): Promise<{ state: 'ready' | 'notYet' | 'expired'; hash?: Uint8Array }> {
  const info = await connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY);
  if (!info || info.data.length < 8) return { state: 'notYet' };
  const dv = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  const len = Math.min(Number(dv.getBigUint64(0, true)), Math.floor((info.data.length - 8) / 40));
  if (len === 0) return { state: 'notYet' };
  const slotAt = (i: number) => dv.getBigUint64(8 + i * 40, true);
  if (slotAt(0) < target) return { state: 'notYet' };
  if (slotAt(len - 1) > target) return { state: 'expired' };
  let i = 0;
  while (i + 1 < len && slotAt(i + 1) >= target) i++;
  return { state: 'ready', hash: info.data.subarray(8 + i * 40 + 8, 8 + i * 40 + 40) };
}
export function rollFrom(slotHash: Uint8Array, a: Uint8Array, b: Uint8Array): bigint {
  const h = keccak(enc('MOONFORGE_RNG'), slotHash, a, b);
  return new DataView(h.buffer, h.byteOffset, 8).getBigUint64(0, true);
}
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export interface BetResult {
  won: boolean; roll: number; payout: number; stake: number; placeTx: string; settleTx: string; expired: boolean;
  /** true once the bet account is closed on-chain (by this browser, a keeper, or anyone) */
  settled: boolean;
  bet: string; seed: string; slotHash: string; targetSlot: number; chanceBps: number; payoutIfWin: number;
}

/**
 * Places a house bet and settles it as soon as the target slot hash exists.
 * Settlement is permissionless; if this tab closes, the public keeper (or anyone) settles it.
 * Bets not settled within ~3 minutes count as lost — this keeps the game unskippable.
 */
export async function playHouse(p: Prov, game: number, param: number, choice: number, stakeXnt: number): Promise<BetResult> {
  const program = getProgram(p);
  const owner = me(p);
  const ps = await ensurePlayer(p);
  const state = await accs(program).playerState.fetch(ps);
  const nonce = BigInt(state.nonce.toString());
  const bet = PDA.bet(ps, nonce);
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const stake = fromXnt(stakeXnt);
  const placeTx = await program.methods.placeBet(game, bn(param), choice, bn(stake), Array.from(seed)).accountsPartial({
    config: PDA.config(), playerState: ps, bet, bankrollVault: PDA.bankrollVault(), rewardVault: PDA.rewardVault(),
    architect: ARCHITECT, signer: owner, systemProgram: SystemProgram.programId,
  }).rpc();
  const b = await accs(program).bet.fetch(bet);
  const target = BigInt(b.targetSlot.toString());
  const conn = program.provider.connection;
  let settleTx = '';
  let settled = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (BigInt(await conn.getSlot('confirmed')) <= target + 1n) continue;
    try {
      settleTx = await program.methods.settleBet().accountsPartial({
        config: PDA.config(), bet, playerState: ps, bankrollVault: PDA.bankrollVault(), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: owner,
      }).rpc();
      settled = true;
      break;
    } catch (e: any) {
      // a keeper (or anyone) may have settled it first: the bet account is then closed
      if (!(await conn.getAccountInfo(bet))) { settled = true; break; }
      if (!String(e).includes('NotReady')) throw e;
    }
  }
  const look = await slotHashLookup(conn, target);
  const h = look.state === 'ready' ? look.hash! : null;
  const roll = h ? Number(rollFrom(h, bet.toBytes(), seed) % 10000n) : -1;
  const won = roll >= 0 && isWin(game, choice, Number(b.chanceBps), roll);
  return {
    won, roll, payout: won ? toXnt(b.payout) : 0, stake: stakeXnt, placeTx, settleTx, expired: look.state === 'expired', settled,
    bet: bet.toBase58(), seed: toHex(seed), slotHash: h ? toHex(h) : '', targetSlot: Number(target), chanceBps: Number(b.chanceBps), payoutIfWin: toXnt(b.payout),
  };
}

export async function enterJackpot(p: Prov, xnt: number) {
  const program = getProgram(p);
  const ps = await ensurePlayer(p);
  const cfg = await accs(program).config.fetch(PDA.config());
  const roundId = Number(cfg.jackpotRound);
  const round = await accs(program).jackpotRound.fetchNullable(PDA.jackpot(roundId));
  const idx = round ? round.entries : 0;
  return program.methods.enterJackpot(bn(roundId), idx, bn(fromXnt(xnt))).accountsPartial({
    config: PDA.config(), round: PDA.jackpot(roundId), entry: PDA.jpEntry(roundId, idx), playerState: ps, signer: me(p), systemProgram: SystemProgram.programId,
  }).rpc();
}

export async function fetchJackpot(connection: Connection = readConnection) {
  const program = getProgram(null, connection);
  const cfg = await accs(program).config.fetchNullable(PDA.config());
  if (!cfg) return null;
  const roundId = Number(cfg.jackpotRound);
  const round = await accs(program).jackpotRound.fetchNullable(PDA.jackpot(roundId));
  const entries = round ? (await accs(program).jackpotEntry.fetchMultiple(Array.from({ length: round.entries }, (_, i) => PDA.jpEntry(roundId, i)))).filter(Boolean) : [];
  const prev = roundId > 0 ? await accs(program).jackpotRound.fetchNullable(PDA.jackpot(roundId - 1)) : null;
  return { roundId, round, entries, previous: prev };
}

export async function enterDraw(p: Prov, chips: number, tickets: number) {
  const program = getProgram(p);
  const ps = await ensurePlayer(p);
  const cfg = await accs(program).config.fetch(PDA.config());
  const roundId = Number(cfg.drawRound);
  const round = await accs(program).drawRound.fetchNullable(PDA.draw(roundId));
  const idx = round ? round.entries : 0;
  return program.methods.enterDraw(bn(roundId), idx, bn(chips), bn(tickets)).accountsPartial({
    config: PDA.config(), round: PDA.draw(roundId), entry: PDA.drawEntry(roundId, idx), playerState: ps, rewardVault: PDA.rewardVault(),
    drawVault: PDA.drawVault(), architect: ARCHITECT, signer: me(p), systemProgram: SystemProgram.programId,
  }).rpc();
}

export async function fetchDraw(connection: Connection = readConnection) {
  const program = getProgram(null, connection);
  const cfg = await accs(program).config.fetchNullable(PDA.config());
  if (!cfg) return null;
  const roundId = Number(cfg.drawRound);
  const round = await accs(program).drawRound.fetchNullable(PDA.draw(roundId));
  const prev = roundId > 0 ? await accs(program).drawRound.fetchNullable(PDA.draw(roundId - 1)) : null;
  return { roundId, round, previous: prev };
}

/** Delivers a won Forge Drop (a Lunar Dust whose floor is the drop value; XNT if Lunar Dust is sold out). */
export async function claimDrop(p: Prov, l: MyLeaf) {
  const program = getProgram(p);
  const player = me(p);
  const proof = l.proof.map((h) => Array.from(ethers.getBytes('0x' + h)));
  const cfg = await accs(program).config.fetch(PDA.config());
  if (Number(cfg.artifactsAlive[0]) >= ARTIFACTS[0].supply) {
    return program.methods.claimDropXnt(bn(l.epoch), l.tier, bn(l.score), proof).accountsPartial({
      config: PDA.config(), epoch: PDA.epoch(l.epoch), receipt: PDA.drop(l.epoch, player, l.tier), player,
      playerState: PDA.player(player), rewardVault: PDA.rewardVault(), payer: player, systemProgram: SystemProgram.programId,
    }).rpc();
  }
  const serial = Number(cfg.artifactsMinted[0]);
  const asset = PDA.asset(0, serial);
  return program.methods.claimDrop(bn(l.epoch), l.tier, serial, bn(l.score), proof).accountsPartial({
    config: PDA.config(), epoch: PDA.epoch(l.epoch), receipt: PDA.drop(l.epoch, player, l.tier), player, asset, record: PDA.artifact(asset),
    collection: PDA.collection(), artifactAuthority: PDA.artifactAuthority(), rewardVault: PDA.rewardVault(), payer: player,
    coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
  }).rpc();
}

/** Jackpot rounds refunded because nobody settled in time, with the entries still to be paid back. */
export async function fetchPendingRefunds(connection: Connection = readConnection) {
  const program = getProgram(null, connection);
  // state (offset 8+8+8+4+32+1+8+8 = 77) == 3: refunded; base58 of [3] is '4'
  const rounds: any[] = await accs(program).jackpotRound.all([{ memcmp: { offset: 77, bytes: '4' } }]);
  const out: { round: number; index: number; player: PublicKey; amount: number; rentPayer: PublicKey }[] = [];
  for (const r of rounds) {
    const id = Number(r.account.id);
    const pks = Array.from({ length: r.account.entries as number }, (_, i) => PDA.jpEntry(id, i));
    const entries: any[] = await accs(program).jackpotEntry.fetchMultiple(pks);
    entries.forEach((e, i) => e && out.push({ round: id, index: i, player: e.player, amount: Number(e.amount), rentPayer: e.rentPayer }));
  }
  return out;
}
/** PERMISSIONLESS: pays back one entry of a refunded jackpot round into its player's game wallet. */
export async function refundJackpotEntry(p: Prov, r: { round: number; index: number; player: PublicKey; rentPayer: PublicKey }) {
  return getProgram(p).methods.closeJackpotEntry().accountsPartial({
    round: PDA.jackpot(r.round), playerState: PDA.player(r.player), entry: PDA.jpEntry(r.round, r.index), rentPayer: r.rentPayer,
  }).rpc();
}

/**
 * PERMISSIONLESS (same as the public keeper): closes an ended Jackpot / Burn Lottery round
 * (draw_jackpot / draw_draw), or settles one that is drawing (settle_jackpot / settle_draw)
 * by passing the entry that holds the winning ticket. Returns null when there is nothing to do yet.
 */
export async function advanceRound(p: Prov, kind: 'jackpot' | 'draw'): Promise<string | null> {
  const program = getProgram(p);
  const conn = program.provider.connection;
  const cfg = await accs(program).config.fetch(PDA.config());
  const roundId = Number(kind === 'jackpot' ? cfg.jackpotRound : cfg.drawRound);
  const roundPk = kind === 'jackpot' ? PDA.jackpot(roundId) : PDA.draw(roundId);
  const round = await (kind === 'jackpot' ? accs(program).jackpotRound : accs(program).drawRound).fetchNullable(roundPk);
  if (!round) return null;
  const now = Math.floor(Date.now() / 1000);
  if (round.state === 0) {
    if (Number(round.endTs) === 0 || now < Number(round.endTs)) return null;
    return kind === 'jackpot'
      ? program.methods.drawJackpot().accountsPartial({ config: PDA.config(), round: roundPk, firstPlayerState: PDA.player(round.firstPlayer) }).rpc()
      : program.methods.drawDraw().accountsPartial({ config: PDA.config(), round: roundPk }).rpc();
  }
  if (round.state !== 1) return null;
  const look = await slotHashLookup(conn, BigInt(round.targetSlot.toString()));
  if (look.state === 'notYet') return null;
  const pks = Array.from({ length: round.entries as number }, (_, i) => (kind === 'jackpot' ? PDA.jpEntry(roundId, i) : PDA.drawEntry(roundId, i)));
  const entries: any[] = await (kind === 'jackpot' ? accs(program).jackpotEntry : accs(program).drawEntry).fetchMultiple(pks);
  let idx = 0; // expired hash: the program refunds the jackpot / sends the lottery prize to the reward pool (any entry)
  if (look.state === 'ready') {
    const total = BigInt((kind === 'jackpot' ? round.total : round.totalWeight).toString());
    const t = rollFrom(look.hash!, roundPk.toBytes(), u64(BigInt(round.id.toString()))) % total;
    const found = entries.findIndex((e) => {
      if (!e) return false;
      const start = BigInt(e.start.toString());
      return t >= start && t < start + BigInt((kind === 'jackpot' ? e.amount : e.weight).toString());
    });
    if (found >= 0) idx = found;
  }
  const e = entries[idx];
  if (!e) return null;
  const common = { config: PDA.config(), round: roundPk, entry: pks[idx], winnerState: PDA.player(e.player), drawVault: PDA.drawVault(), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY };
  return kind === 'jackpot'
    ? program.methods.settleJackpot().accountsPartial({ ...common, rewardVault: PDA.rewardVault(), architect: ARCHITECT }).rpc()
    : program.methods.settleDraw().accountsPartial({ ...common, rewardVault: PDA.rewardVault() }).rpc();
}

/** Forges at the price shown: if someone forged first (+5%), the transaction fails instead of charging more. */
export async function forgeArtifact(p: Prov, tier: number, maxPriceLamports?: bigint) {
  const program = getProgram(p);
  const cfg = await accs(program).config.fetch(PDA.config());
  const serial = cfg.artifactsMinted[tier];
  const asset = PDA.asset(tier, serial);
  const maxPrice = maxPriceLamports ?? artifactPrice(cfg, tier);
  return program.methods.forgeArtifact(tier, serial, bn(maxPrice)).accountsPartial({
    config: PDA.config(), asset, record: PDA.artifact(asset), collection: PDA.collection(), artifactAuthority: PDA.artifactAuthority(),
    rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: ARCHITECT, buyer: me(p), coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
  }).rpc();
}

export async function recycleArtifact(p: Prov, asset: PublicKey) {
  return getProgram(p).methods.recycleArtifact().accountsPartial({
    config: PDA.config(), asset, record: PDA.artifact(asset), collection: PDA.collection(), owner: me(p), coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
  }).rpc();
}

export async function claimArtifactChips(p: Prov, asset: PublicKey) {
  await ensurePlayer(p);
  return getProgram(p).methods.claimArtifactChips().accountsPartial({
    config: PDA.config(), asset, record: PDA.artifact(asset), collection: PDA.collection(), playerState: PDA.player(me(p)), owner: me(p),
  }).rpc();
}

export async function claimAirdrop(p: Prov) {
  const r = await fetch(`${import.meta.env.BASE_URL}airdrop/airdrop.json`, { cache: 'no-store' });
  if (!r.ok) throw new Error('No airdrop list published yet');
  const list = await r.json();
  const proof: string[] | undefined = list.proofs?.[me(p).toBase58()];
  if (!proof) throw new Error('This wallet is not in the Genesis airdrop list');
  const program = getProgram(p);
  const cfg = await accs(program).config.fetch(PDA.config());
  const serial = cfg.artifactsMinted[0];
  const asset = PDA.asset(0, serial);
  return program.methods.claimAirdrop(serial, proof.map((h) => Array.from(ethers.getBytes('0x' + h)))).accountsPartial({
    config: PDA.config(), receipt: PDA.airdrop(me(p)), asset, record: PDA.artifact(asset), collection: PDA.collection(),
    artifactAuthority: PDA.artifactAuthority(), claimant: me(p), coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
  }).rpc();
}

// Artifact Duel
export function duelCommitment(duel: PublicKey, element: number, salt: Uint8Array) {
  return keccak(enc('MOONFORGE_DUEL'), Uint8Array.of(element), salt, duel.toBytes());
}
/** An Artifact (any tier) is the ticket to the arena; the element is free and stays hidden until reveal. */
export async function createDuel(p: Prov, stakeXnt: number, element: number, ticketAsset: PublicKey) {
  const program = getProgram(p);
  const ps = await ensurePlayer(p);
  const st = await accs(program).playerState.fetch(ps);
  const duel = PDA.duel(me(p), BigInt(st.nonce.toString()));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  // the secret never leaves this browser until reveal
  localStorage.setItem(`moonforge_duel_${duel.toBase58()}`, JSON.stringify({ element, salt: Array.from(salt) }));
  const tx = await program.methods.createDuel(bn(fromXnt(stakeXnt)), Array.from(duelCommitment(duel, element, salt))).accountsPartial({
    config: PDA.config(), creatorState: ps, duel, owner: me(p), asset: ticketAsset, record: PDA.artifact(ticketAsset), collection: PDA.collection(),
    systemProgram: SystemProgram.programId,
  }).rpc();
  return { tx, duel };
}
export async function joinDuel(p: Prov, duel: PublicKey, element: number, ticketAsset: PublicKey) {
  const asset = ticketAsset;
  await ensurePlayer(p);
  return getProgram(p).methods.joinDuel(element).accountsPartial({
    config: PDA.config(), duel, opponentState: PDA.player(me(p)), opponent: me(p), asset, record: PDA.artifact(asset), collection: PDA.collection(),
  }).rpc();
}
function resolveAccounts(d: any, duel: PublicKey) {
  return {
    config: PDA.config(), duel, creatorState: PDA.player(d.creator), opponentState: PDA.player(d.opponent), rewardVault: PDA.rewardVault(),
    drawVault: PDA.drawVault(), architect: ARCHITECT, rentPayer: d.rentPayer,
  };
}
export async function revealDuel(p: Prov, duel: PublicKey) {
  const program = getProgram(p);
  const d = await accs(program).duel.fetch(duel);
  const secret = JSON.parse(localStorage.getItem(`moonforge_duel_${duel.toBase58()}`) || 'null');
  if (!secret) throw new Error('Duel secret not found in this browser');
  return program.methods.revealDuel(secret.element, secret.salt).accountsPartial({
    resolve: resolveAccounts(d, duel), creator: me(p),
  }).rpc();
}
export async function claimDuelTimeout(p: Prov, duel: PublicKey) {
  const program = getProgram(p);
  const d = await accs(program).duel.fetch(duel);
  return program.methods.claimDuelTimeout().accountsPartial(resolveAccounts(d, duel)).rpc();
}
export async function cancelDuel(p: Prov, duel: PublicKey) {
  return getProgram(p).methods.cancelDuel().accountsPartial({ duel, creatorState: PDA.player(me(p)), creator: me(p) }).rpc();
}
/** The creator's secret (element + salt) saved by createDuel in this browser, if any. */
export function duelSecret(duel: PublicKey): { element: number; salt: number[] } | null {
  try { return JSON.parse(localStorage.getItem(`moonforge_duel_${duel.toBase58()}`) || 'null'); } catch { return null; }
}
export async function fetchOpenDuels(connection: Connection = readConnection) {
  const program = getProgram(null, connection);
  const all: any[] = await accs(program).duel.all();
  return all.filter((d) => d.account.state === 0 || d.account.state === 1);
}

// ── Moon Wars (real) and Predictions ────────────────────────────────────────
/** Both are in the program source and tested; they become playable after the next program upgrade. */
export const NEXT_UPGRADE_LIVE = false;

export const WAR = {
  minStakeXnt: 0.1, startHp: 20, fieldMax: 6, maxRounds: 100, turnSeconds: 120, solarBurn: 2,
  // power, defense, cost — same as the practice engine and constants.rs WAR_CARDS
  cards: [
    { name: 'Lunar Dust', power: 2, defense: 2, cost: 1 },
    { name: 'Cosmic Shard', power: 4, defense: 3, cost: 2 },
    { name: 'Solar Core', power: 6, defense: 4, cost: 3 },
    { name: 'Void Anomaly', power: 10, defense: 10, cost: 5 },
  ],
  /** a small XNT top-up for the browser move key, so each move needs no wallet pop-up (leftover is swept back) */
  moveKeyFundXnt: 0.005,
  state: { OPEN: 0, STARTING: 1, ACTIVE: 2, DONE: 3 },
} as const;

const warPda = (c: PublicKey, n: number | bigint) => pda(enc('war'), c.toBytes(), u64(n));
const moveKeyName = (war: PublicKey) => `moonforge_war_key_${war.toBase58()}`;
/** The move key generated in this browser for a match, if any. */
export function warMoveKey(war: PublicKey): Keypair | null {
  try {
    const s = localStorage.getItem(moveKeyName(war));
    return s ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s))) : null;
  } catch { return null; }
}
function newMoveKey(war: PublicKey): Keypair {
  const k = Keypair.generate();
  localStorage.setItem(moveKeyName(war), JSON.stringify(Array.from(k.secretKey)));
  return k;
}
const fundMoveKey = (p: Prov, k: Keypair) => SystemProgram.transfer({ fromPubkey: me(p), toPubkey: k.publicKey, lamports: fromXnt(WAR.moveKeyFundXnt) });

/** Creates a match: stake from the game wallet, an Artifact you hold as the ticket, and a browser move key. */
export async function createWar(p: Prov, stakeXnt: number, ticketAsset: PublicKey) {
  const program = getProgram(p);
  const ps = await ensurePlayer(p);
  const st = await accs(program).playerState.fetch(ps);
  const war = warPda(me(p), BigInt(st.nonce.toString()));
  const key = newMoveKey(war);
  const tx = await program.methods.createWar(bn(fromXnt(stakeXnt)), key.publicKey).accountsPartial({
    config: PDA.config(), creatorState: ps, war, owner: me(p), asset: ticketAsset, record: PDA.artifact(ticketAsset), collection: PDA.collection(),
    systemProgram: SystemProgram.programId,
  }).postInstructions([fundMoveKey(p, key)]).rpc();
  return { tx, war };
}
export async function joinWar(p: Prov, war: PublicKey, ticketAsset: PublicKey) {
  await ensurePlayer(p);
  const key = newMoveKey(war);
  return getProgram(p).methods.joinWar(key.publicKey).accountsPartial({
    config: PDA.config(), war, opponentState: PDA.player(me(p)), opponent: me(p), asset: ticketAsset, record: PDA.artifact(ticketAsset), collection: PDA.collection(),
  }).postInstructions([fundMoveKey(p, key)]).rpc();
}
export async function cancelWar(p: Prov, war: PublicKey) {
  return getProgram(p).methods.cancelWar().accountsPartial({ war, creatorState: PDA.player(me(p)), creator: me(p) }).rpc();
}
/** PERMISSIONLESS: shuffles both decks with the hash of the block committed at join. */
export async function startWar(p: Prov, war: PublicKey) {
  return getProgram(p).methods.startWar().accountsPartial({ war, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).rpc();
}
/** A move signed by this browser's move key when it has one (no pop-up), else by the wallet. */
async function warMove(p: Prov, war: PublicKey, build: (m: any) => any) {
  const key = warMoveKey(war);
  if (!key) return build(getProgram(p).methods).accountsPartial({ war, signer: me(p) }).rpc();
  const connection = readConnection;
  const program = getProgram(null, connection);
  const tx: Transaction = await build(program.methods).accountsPartial({ war, signer: key.publicKey }).transaction();
  tx.feePayer = key.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(key);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}
export const warSummon = (p: Prov, war: PublicKey, handIndex: number) => warMove(p, war, (m) => m.warSummon(handIndex));
/** target = enemy unit index, or 255 for the enemy player (only when its field is empty) */
export const warAttack = (p: Prov, war: PublicKey, attacker: number, target: number) => warMove(p, war, (m) => m.warAttack(attacker, target));
export const warEndTurn = (p: Prov, war: PublicKey) => warMove(p, war, (m) => m.warEndTurn());
export async function claimWarTimeout(p: Prov, war: PublicKey) {
  return getProgram(p).methods.claimWarTimeout().accountsPartial({ war }).rpc();
}
/** PERMISSIONLESS once finished: winner paid (or both refunded on a draw); the move key's leftover goes back. */
export async function settleWar(p: Prov, war: PublicKey) {
  const program = getProgram(p);
  const w = await accs(program).war.fetch(war);
  const sig = await program.methods.settleWar().accountsPartial({
    config: PDA.config(), war, creatorState: PDA.player(w.creator), opponentState: PDA.player(w.opponent), rewardVault: PDA.rewardVault(),
    drawVault: PDA.drawVault(), architect: ARCHITECT, rentPayer: w.rentPayer,
  }).rpc();
  await sweepMoveKey(p, war).catch(() => undefined);
  return sig;
}
/** Sends what is left on this browser's move key back to the wallet. */
export async function sweepMoveKey(p: Prov, war: PublicKey) {
  const key = warMoveKey(war);
  if (!key) return null;
  const connection = readConnection;
  const lamports = await connection.getBalance(key.publicKey, 'confirmed');
  if (lamports > 5000) {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: key.publicKey, toPubkey: me(p), lamports: lamports - 5000 }));
    tx.feePayer = key.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(key);
    await connection.confirmTransaction(await connection.sendRawTransaction(tx.serialize()), 'confirmed');
  }
  localStorage.removeItem(moveKeyName(war));
  return lamports;
}
/** Open matches (anyone can join) plus every match where `owner` plays. War layout: disc 8 | creator 32 | opponent 32 | nonce 8 | stake 8 | state 1 */
export async function fetchWars(owner: PublicKey | null, connection: Connection = readConnection) {
  const program = getProgram(null, connection);
  const open = accs(program).war.all([{ memcmp: { offset: 88, bytes: '1' } }]); // state 0 (base58 of [0] is '1')
  const mine = owner
    ? Promise.all([
      accs(program).war.all([{ memcmp: { offset: 8, bytes: owner.toBase58() } }]),
      accs(program).war.all([{ memcmp: { offset: 40, bytes: owner.toBase58() } }]),
    ])
    : Promise.resolve([[], []]);
  const [o, [a, b]] = await Promise.all([open, mine]);
  const seen = new Map<string, any>();
  for (const w of [...a, ...b, ...o]) seen.set(w.publicKey.toBase58(), w);
  return [...seen.values()] as { publicKey: PublicKey; account: any }[];
}

export const PRED = {
  periodSeconds: 24 * 3600, betWindowSeconds: 12 * 3600, horizonSeconds: 24 * 3600, twapSeconds: 15 * 60,
  maxPotXnt: 200, maxDelaySeconds: 24 * 3600, minStakeXnt: 0.01,
  state: { OPEN: 0, LOCKED: 1, SETTLED: 2, REFUND: 3 },
  side: { DOWN: 0, UP: 1 },
} as const;
export const XDEX_OBSERVATION = new PublicKey('4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ');
const predPda = (r: number) => pda(enc('pred'), u64(r));
const predEntryPda = (r: number, pl: PublicKey) => pda(enc('pred_entry'), u64(r), pl.toBytes());
export const currentPredRound = (now = Math.floor(Date.now() / 1000)) => Math.floor(now / PRED.periodSeconds);
export const predTimes = (id: number) => {
  const open = id * PRED.periodSeconds, lock = open + PRED.betWindowSeconds;
  return { open, lock, end: lock + PRED.horizonSeconds };
};

/** USD per XNT from an XDEX price × 2^32 (token 0 = WXNT, 9 decimals; token 1 = USDC.X, 6 decimals). */
export const x32ToUsd = (x32: bigint | number | string) => (Number(BigInt(x32.toString())) / 2 ** 32) * 1e3;
/** Same computation as the program's twap_from: TWAP over [end - window, end] from the stored observations. */
export function twapFromObservation(data: Uint8Array, end: number, window = PRED.twapSeconds): { x32: bigint } | 'notYet' | 'unavailable' {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const start = end - window;
  let lo: [number, bigint] | null = null, hi: [number, bigint] | null = null;
  for (let i = 0; i < 100; i++) {
    const o = 43 + i * 40;
    const ts = Number(v.getBigUint64(o, true));
    if (!ts) continue;
    const cum = v.getBigUint64(o + 8, true) | (v.getBigUint64(o + 16, true) << 64n);
    if (ts <= start && (!lo || ts > lo[0])) lo = [ts, cum];
    if (ts >= end && (!hi || ts < hi[0])) hi = [ts, cum];
  }
  if (!hi) return 'notYet';
  if (!lo || hi[0] <= lo[0]) return 'unavailable';
  return { x32: (hi[1] - lo[1]) / BigInt(hi[0] - lo[0]) };
}
/** The 15-minute TWAP ending at the newest observation, in USD per XNT. */
export async function fetchLiveTwap(connection: Connection = readConnection): Promise<{ usd: number; asOf: number } | null> {
  const info = await connection.getAccountInfo(XDEX_OBSERVATION, 'confirmed');
  if (!info) return null;
  const v = new DataView(info.data.buffer, info.data.byteOffset, info.data.byteLength);
  let newest = 0;
  for (let i = 0; i < 100; i++) newest = Math.max(newest, Number(v.getBigUint64(43 + i * 40, true)));
  const t = twapFromObservation(info.data, newest);
  return typeof t === 'object' ? { usd: x32ToUsd(t.x32), asOf: newest } : null;
}

export async function fetchPredRound(id: number, connection: Connection = readConnection) {
  return accs(getProgram(null, connection)).predRound.fetchNullable(predPda(id));
}
/** Entries of `owner` not claimed yet. PredEntry layout: disc 8 | round 8 | player 32 */
export async function fetchMyPredEntries(owner: PublicKey, connection: Connection = readConnection) {
  return (await accs(getProgram(null, connection)).predEntry.all([{ memcmp: { offset: 16, bytes: owner.toBase58() } }])) as { publicKey: PublicKey; account: any }[];
}
/** Wallet owner only (never a bot session key); one entry per wallet per round. */
export async function enterPrediction(p: Prov, side: 0 | 1, xnt: number) {
  const ps = await ensurePlayer(p);
  const id = currentPredRound();
  return getProgram(p).methods.enterPrediction(bn(id), side, bn(fromXnt(xnt))).accountsPartial({
    round: predPda(id), entry: predEntryPda(id, me(p)), playerState: ps, owner: me(p), systemProgram: SystemProgram.programId,
  }).rpc();
}
/** PERMISSIONLESS: moves a round forward (lock after its entry window, settle after its end time). */
export async function advancePrediction(p: Prov, id: number) {
  const program = getProgram(p);
  const r = await accs(program).predRound.fetch(predPda(id));
  if (r.state === PRED.state.OPEN) return program.methods.lockPrediction().accountsPartial({ round: predPda(id), observation: XDEX_OBSERVATION }).rpc();
  return program.methods.settlePrediction().accountsPartial({
    config: PDA.config(), round: predPda(id), observation: XDEX_OBSERVATION, rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: ARCHITECT,
  }).rpc();
}
/** PERMISSIONLESS: pays an entry (winner share or refund) into its owner's game wallet and closes it. */
export async function claimPrediction(p: Prov, entry: { publicKey: PublicKey; account: any }) {
  const id = Number(entry.account.round);
  return getProgram(p).methods.claimPrediction().accountsPartial({
    config: PDA.config(), round: predPda(id), entry: entry.publicKey, playerState: PDA.player(entry.account.player), rentPayer: entry.account.rentPayer,
  }).rpc();
}
/** What an entry receives: winners share the prize pool pro-rata; a refunded round returns the stake. */
export function predPayout(round: any, entry: any): bigint {
  const amount = BigInt(entry.amount.toString());
  if (round.state === PRED.state.REFUND) return amount;
  if (round.state !== PRED.state.SETTLED || entry.side !== round.outcome) return 0n;
  return (amount * BigInt(round.prizePool.toString())) / BigInt(round.totals[entry.side].toString());
}

// Be the House — deposits are priced at the optimistic value (pending bets counted as lost),
// withdrawals at the conservative value (pending bets counted as won). See games.rs.
async function bankrollValues(connection: Connection) {
  const cfg = await accs(getProgram(null, connection)).config.fetch(PDA.config());
  const info = await connection.getAccountInfo(PDA.bankrollVault());
  const rent = info ? await connection.getMinimumBalanceForRentExemption(info.data.length) : 0;
  const optimistic = BigInt(Math.max(0, (info?.lamports ?? 0) - rent));
  return { cfg, optimistic, conservative: optimistic - BigInt(cfg.bankrollReserved.toString()) };
}
/** Shares a deposit would mint right now (games.rs::house_deposit). */
export async function houseDepositQuote(xnt: number, connection: Connection = readConnection) {
  const { cfg, optimistic } = await bankrollValues(connection);
  const value = optimistic > 1_000_000n ? optimistic : 1_000_000n;
  const total = BigInt(cfg.houseTotalShares.toString()) === 0n ? value : BigInt(cfg.houseTotalShares.toString());
  return (BigInt(fromXnt(xnt)) * total) / value;
}
/** Lamports a withdrawal of `shares` would pay right now (games.rs::house_withdraw). */
export async function houseWithdrawQuote(shares: bigint, connection: Connection = readConnection) {
  const { cfg, conservative } = await bankrollValues(connection);
  const total = BigInt(cfg.houseTotalShares.toString());
  return total === 0n || conservative <= 0n ? 0n : (shares * conservative) / total;
}
/** Slippage limit: the transaction fails instead of executing more than 1% worse than quoted. */
export async function houseDeposit(p: Prov, xnt: number) {
  const minShares = ((await houseDepositQuote(xnt)) * 99n) / 100n;
  return getProgram(p).methods.houseDeposit(bn(fromXnt(xnt)), bn(minShares)).accountsPartial({
    config: PDA.config(), share: PDA.house(me(p)), bankrollVault: PDA.bankrollVault(), owner: me(p), systemProgram: SystemProgram.programId,
  }).rpc();
}
export async function houseRequestWithdraw(p: Prov, shares: bigint) {
  return getProgram(p).methods.houseRequestWithdraw(bn(shares)).accountsPartial({ share: PDA.house(me(p)), owner: me(p) }).rpc();
}
export async function houseWithdraw(p: Prov) {
  const share = await fetchHouseShare(me(p));
  const pending = share ? BigInt(share.pendingShares.toString()) : 0n;
  const minLamports = ((await houseWithdrawQuote(pending)) * 99n) / 100n;
  return getProgram(p).methods.houseWithdraw(bn(minLamports)).accountsPartial({ config: PDA.config(), share: PDA.house(me(p)), bankrollVault: PDA.bankrollVault(), owner: me(p) }).rpc();
}
export async function fetchHouseShare(owner: PublicKey, connection: Connection = readConnection) {
  return accs(getProgram(null, connection)).houseShare.fetchNullable(PDA.house(owner));
}

// ── EVM burn (MoonForgePortal v2) ──────────────────────────────────────────
export const PORTAL_ABI = [
  'function enterForge(uint256 amount, uint8 tier, bytes32 x1Pubkey)',
  'function totalBurned() view returns (uint256)',
  'function totalMissions() view returns (uint256)',
  'event MissionStarted(uint256 indexed missionId, address indexed pilot, uint256 amount, uint8 tier, bytes32 x1Pubkey, uint256 chainId, uint256 timestamp)',
  'error InvalidXen()', 'error InvalidAmount()', 'error InvalidTier()', 'error InvalidX1Address()',
  'error Busy()', 'error NotXen()', 'error UnexpectedCallback()', 'error CallbackMissing()',
];
export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];
/** Base58 X1 address → 32-byte hex for the portal. Throws on anything that is not a valid key. */
export function x1ToBytes32(x1: string): string {
  if (x1.trim().toLowerCase().startsWith('0x')) throw new Error('That is an EVM address. Paste your X1 (Base58) address.');
  let pk: PublicKey;
  try { pk = new PublicKey(x1.trim()); } catch { throw new Error('Not a valid X1 (Base58) address.'); }
  return ethers.hexlify(pk.toBytes());
}
export async function burnXen(
  signer: ethers.Signer, portal: string, xen: string, amountWei: bigint, tier: number, x1: string,
  onStep?: (step: 'approve' | 'burn', txHash?: string) => void,
) {
  const owner = await signer.getAddress();
  const token = new ethers.Contract(xen, ERC20_ABI, signer);
  const allowance: bigint = await token.allowance(owner, portal);
  if (allowance < amountWei) {
    onStep?.('approve');
    const tx = await token.approve(portal, amountWei); // exact amount, never infinite
    onStep?.('approve', tx.hash);
    await tx.wait();
  }
  onStep?.('burn');
  const p = new ethers.Contract(portal, PORTAL_ABI, signer);
  const tx = await p.enterForge(amountWei, tier, x1ToBytes32(x1));
  onStep?.('burn', tx.hash);
  return tx.wait();
}
export async function xenBalanceOf(provider: ethers.Provider, xen: string, owner: string): Promise<bigint> {
  return new ethers.Contract(xen, ERC20_ABI, provider).balanceOf(owner);
}
/** Decodes the MissionStarted event emitted by `portal` in a burn receipt (null if absent = nothing was registered). */
export function parseMissionStarted(receipt: ethers.TransactionReceipt | null, portal: string) {
  if (!receipt) return null;
  const iface = new ethers.Interface(PORTAL_ABI);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== portal.toLowerCase()) continue;
    try {
      const ev = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (ev?.name === 'MissionStarted') {
        return { missionId: ev.args.missionId as bigint, amount: ev.args.amount as bigint, tier: Number(ev.args.tier), x1: new PublicKey(ethers.getBytes(ev.args.x1Pubkey)).toBase58() };
      }
    } catch { /* not ours */ }
  }
  return null;
}
