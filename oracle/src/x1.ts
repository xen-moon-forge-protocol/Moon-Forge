/**
 * X1 side: Anchor client, PDAs, Artifact snapshot, epoch publication and the
 * permissionless keeper (auto-claims for burners, seals and delivers Forge Drops, settles bets,
 * jackpots and lotteries, pays back refunded rounds, expires old epochs).
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SYSVAR_SLOT_HASHES_PUBKEY, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";
import { ORACLE_PRIVATE_KEY, PROGRAM_ID, X1_RPC } from "./config";
import { ArtifactHolder, EpochFile } from "./epoch";
import { keccak } from "./merkle";
import idl from "./idl/moon_forge.json";

export const programId = new PublicKey(PROGRAM_ID);
export const ARCHITECT = new PublicKey("7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd");
/** XDEX WXNT/USDC.X observation account: the price source of Predictions (checked by the program). */
export const XDEX_XNT_OBSERVATION = new PublicKey("4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ");
export const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

const u64 = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];

export const PDA = {
  config: () => pda(Buffer.from("config")),
  rewardVault: () => pda(Buffer.from("reward_vault")),
  bankrollVault: () => pda(Buffer.from("bankroll_vault")),
  drawVault: () => pda(Buffer.from("draw_vault")),
  epoch: (id: number | bigint) => pda(Buffer.from("epoch"), u64(id)),
  receipt: (id: number | bigint, player: PublicKey, tier: number) => pda(Buffer.from("receipt"), u64(id), player.toBuffer(), Buffer.from([tier])),
  mission: (id: number | bigint, player: PublicKey, tier: number) => pda(Buffer.from("mission"), u64(id), player.toBuffer(), Buffer.from([tier])),
  player: (owner: PublicKey) => pda(Buffer.from("player"), owner.toBuffer()),
  bet: (playerState: PublicKey, nonce: number | bigint) => pda(Buffer.from("bet"), playerState.toBuffer(), u64(nonce)),
  jackpot: (round: number | bigint) => pda(Buffer.from("jackpot"), u64(round)),
  jpEntry: (round: number | bigint, idx: number) => pda(Buffer.from("jp_entry"), u64(round), u32(idx)),
  draw: (round: number | bigint) => pda(Buffer.from("draw"), u64(round)),
  drawEntry: (round: number | bigint, idx: number) => pda(Buffer.from("draw_entry"), u64(round), u32(idx)),
  collection: () => pda(Buffer.from("collection")),
  artifact: (asset: PublicKey) => pda(Buffer.from("artifact"), asset.toBuffer()),
  asset: (tier: number, serial: number) => pda(Buffer.from("asset"), Buffer.from([tier]), u32(serial)),
  authority: () => pda(Buffer.from("artifact_authority")),
  drop: (id: number | bigint, player: PublicKey, tier: number) => pda(Buffer.from("drop"), u64(id), player.toBuffer(), Buffer.from([tier])),
};

/** drops.rs::DROP_BACKING — the initial recycle value of a Lunar Dust (5 XNT). */
export const DROP_BACKING = 5_000_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function loadKeypair(secret = ORACLE_PRIVATE_KEY): Keypair {
  if (!secret) throw new Error("ORACLE_PRIVATE_KEY not set");
  const s = secret.trim();
  if (s.startsWith("0x")) throw new Error("ORACLE_PRIVATE_KEY looks like an EVM key; X1 needs a Solana/SVM keypair");
  const bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s);
  return Keypair.fromSecretKey(bytes);
}

export function connect(signer?: Keypair) {
  const connection = new Connection(X1_RPC, "confirmed");
  const wallet = new anchor.Wallet(signer ?? Keypair.generate());
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new anchor.Program(idl as anchor.Idl, provider);
  return { connection, provider, program, wallet };
}

/** Owners of live Moon Forge Artifacts at the current slot (for burn boosts). */
export async function artifactSnapshot(connection: Connection, program: anchor.Program): Promise<{ slot: number; holders: ArtifactHolder[] }> {
  const slot = await connection.getSlot("finalized");
  const records: any[] = await (program.account as any).artifactRecord.all();
  const collection = PDA.collection();
  const holders: ArtifactHolder[] = [];
  for (let i = 0; i < records.length; i += 100) {
    const chunk = records.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk.map((r) => r.account.asset as PublicKey), "finalized");
    infos.forEach((info, j) => {
      if (!info || !info.owner.equals(MPL_CORE) || info.data.length < 66) return;
      if (info.data[0] !== 1 || info.data[33] !== 2) return;
      if (!new PublicKey(info.data.subarray(34, 66)).equals(collection)) return;
      holders.push({
        owner: new PublicKey(info.data.subarray(1, 33)).toBase58(),
        asset: (chunk[j].account.asset as PublicKey).toBase58(),
        tier: chunk[j].account.tier,
      });
    });
  }
  holders.sort((a, b) => (a.asset < b.asset ? -1 : 1));
  return { slot, holders };
}

export async function fetchConfig(program: anchor.Program): Promise<any> {
  return (program.account as any).config.fetch(PDA.config());
}

export async function publishEpoch(program: anchor.Program, oracle: Keypair, f: EpochFile): Promise<string> {
  return program.methods
    .publishEpoch(
      new anchor.BN(f.epoch),
      Array.from(Buffer.from(f.root, "hex")),
      Array.from(Buffer.from(f.dataHash, "hex")),
      new anchor.BN(f.totalScore),
      f.leaves.length,
      new anchor.BN(f.rateCap),
    )
    .accountsPartial({
      config: PDA.config(),
      epoch: PDA.epoch(f.epoch),
      rewardVault: PDA.rewardVault(),
      oracle: oracle.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([oracle])
    .rpc();
}

/**
 * Seals the Forge Drop seed of a freshly published epoch (permissionless). The seed is the hash of
 * a block produced after publication; it must be read within ~512 slots, so this runs right away.
 */
export async function sealDrop(program: anchor.Program, payer: Keypair, epochId: number, log = console.log): Promise<boolean> {
  for (let i = 0; i < 90; i++) {
    const e: any = await (program.account as any).epoch.fetchNullable(PDA.epoch(epochId));
    if (!e || e.dropState !== 1 || e.closed) return false;
    try {
      const sig = await program.methods.sealDrop()
        .accountsPartial({ config: PDA.config(), epoch: PDA.epoch(epochId), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY })
        .signers([payer]).rpc();
      log(`  drops of epoch ${epochId} sealed: ${sig}`);
      return true;
    } catch (err) {
      const t = String(err);
      if (t.includes("DropNotPending") || t.includes("EpochClosed")) return false;
      // NotReady, or a transient RPC error: keep trying while the window lasts (re-checked above)
      if (!t.includes("NotReady")) log(`  seal attempt for epoch ${epochId}: ${t.slice(0, 160)}`);
      await sleep(1000);
    }
  }
  return false;
}

/** Exact mirror of drops.rs::drop_outcome. */
export function dropOutcome(ep: any, player: PublicKey, tier: number, score: bigint): { won: boolean; value: bigint } {
  const reserve = BigInt(ep.dropReserve.toString());
  const total = BigInt(ep.totalScore.toString());
  if (reserve === 0n || total === 0n) return { won: false, value: 0n };
  const value = (score * reserve) / total;
  if (value >= DROP_BACKING) return { won: true, value };
  const r = randomU64(Buffer.from(ep.dropSeed), player.toBuffer(), Buffer.from([tier])) % DROP_BACKING;
  return { won: r < value, value: DROP_BACKING };
}

/** Delivers every won, undelivered Forge Drop of an epoch (permissionless; the Artifact goes to the player). */
export async function deliverDrops(connection: Connection, program: anchor.Program, payer: Keypair, f: EpochFile, log = console.log) {
  const ep: any = await (program.account as any).epoch.fetchNullable(PDA.epoch(f.epoch));
  if (!ep || ep.dropState !== 2 || ep.closed || Date.now() / 1000 >= Number(ep.expiresAt)) return 0;
  let done = 0;
  for (const l of f.leaves) {
    const player = new PublicKey(l.player);
    if (!dropOutcome(ep, player, l.tier, BigInt(l.score)).won) continue;
    const receipt = PDA.drop(f.epoch, player, l.tier);
    if (await connection.getAccountInfo(receipt)) continue;
    const proof = (f.proofs[`${l.player}:${l.tier}`] || []).map((h) => Array.from(Buffer.from(h, "hex")));
    const cfg = await fetchConfig(program);
    try {
      let sig: string;
      if (Number(cfg.artifactsAlive[0]) >= 600) {
        sig = await program.methods.claimDropXnt(new anchor.BN(f.epoch), l.tier, new anchor.BN(l.score), proof).accountsPartial({
          config: PDA.config(), epoch: PDA.epoch(f.epoch), receipt, player, playerState: PDA.player(player),
          rewardVault: PDA.rewardVault(), payer: payer.publicKey, systemProgram: SystemProgram.programId,
        }).signers([payer]).rpc();
      } else {
        const serial = Number(cfg.artifactsMinted[0]);
        const asset = PDA.asset(0, serial);
        sig = await program.methods.claimDrop(new anchor.BN(f.epoch), l.tier, serial, new anchor.BN(l.score), proof).accountsPartial({
          config: PDA.config(), epoch: PDA.epoch(f.epoch), receipt, player, asset, record: PDA.artifact(asset), collection: PDA.collection(),
          artifactAuthority: PDA.authority(), rewardVault: PDA.rewardVault(), payer: payer.publicKey, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
        }).signers([payer]).rpc();
      }
      done++;
      log(`  Forge Drop delivered to ${l.player} (epoch ${f.epoch}, tier ${l.tier}): ${sig}`);
    } catch (e) {
      log(`  drop delivery failed for ${l.player} tier ${l.tier}: ${String(e).slice(0, 200)}`);
    }
  }
  return done;
}

/** Submits every not-yet-claimed leaf (claims are permissionless; XNT goes to the player). */
export async function claimAll(connection: Connection, program: anchor.Program, payer: Keypair, f: EpochFile, log = console.log) {
  let done = 0;
  for (const l of f.leaves) {
    const player = new PublicKey(l.player);
    const receipt = PDA.receipt(f.epoch, player, l.tier);
    if (await connection.getAccountInfo(receipt)) continue;
    const proof = (f.proofs[`${l.player}:${l.tier}`] || []).map((h) => Array.from(Buffer.from(h, "hex")));
    const common = {
      config: PDA.config(),
      epoch: PDA.epoch(f.epoch),
      receipt,
      player,
      playerState: PDA.player(player),
      rewardVault: PDA.rewardVault(),
      payer: payer.publicKey,
      systemProgram: SystemProgram.programId,
    };
    try {
      const m = l.tier === 0
        ? program.methods.claimInstant(new anchor.BN(f.epoch), l.tier, new anchor.BN(l.score), proof).accountsPartial(common)
        : program.methods.claimMission(new anchor.BN(f.epoch), l.tier, new anchor.BN(l.score), proof).accountsPartial({ ...common, mission: PDA.mission(f.epoch, player, l.tier) });
      const sig = await m.signers([payer]).rpc();
      done++;
      log(`  claimed ${l.player} tier ${l.tier}: ${sig}`);
    } catch (e) {
      log(`  claim failed for ${l.player} tier ${l.tier}: ${String(e).slice(0, 200)}`);
    }
  }
  return done;
}

// ── Randomness helpers (mirror utils.rs) ─────────────────────────────────────

export async function slotHashAtOrAfter(connection: Connection, target: bigint): Promise<Buffer | null> {
  const info = await connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY);
  if (!info) return null;
  const d = info.data;
  const len = Number(d.readBigUInt64LE(0));
  let best: Buffer | null = null;
  for (let i = 0; i < len; i++) {
    const o = 8 + i * 40;
    const slot = d.readBigUInt64LE(o);
    if (slot >= target) best = d.subarray(o + 8, o + 40);
    else break;
  }
  return best;
}

export function randomU64(slotHash: Buffer, a: Buffer, b: Buffer): bigint {
  return keccak(Buffer.from("MOONFORGE_RNG"), slotHash, a, b).readBigUInt64LE(0);
}

/**
 * One keeper pass (everything here is permissionless):
 *  settle bets whose target slot passed, run jackpot and lottery rounds, pay back refunded jackpot
 *  entries, seal pending Forge Drop seeds, claim pending leaves and deliver won drops of the given
 *  epoch files, and expire epochs whose claim window closed (their reserve returns to the pool).
 */
export async function keeperPass(connection: Connection, program: anchor.Program, payer: Keypair, log = console.log, epochFiles: EpochFile[] = []) {
  const acc = program.account as any;
  const now = Math.floor(Date.now() / 1000);
  const cfg = await fetchConfig(program);

  // 1. draws first, always (their block hash must be used within ~512 slots): a player who lost
  //    must never be able to delay them by flooding the keeper with other work
  await runRound(connection, program, payer, "jackpot", cfg.jackpotRound, now, log);
  await runRound(connection, program, payer, "draw", cfg.drawRound, now, log);
  const slot = BigInt(await connection.getSlot("confirmed"));

  // 2. unsettled bets (players' browsers normally settle their own), in small batches with the
  //    draws re-checked between batches so a flood of bets can never delay a draw
  const bets: any[] = (await acc.bet.all()).filter((b: any) => BigInt(b.account.targetSlot.toString()) < slot);
  for (let i = 0; i < Math.min(bets.length, 60); i++) {
    const b = bets[i];
    try {
      await program.methods.settleBet().accountsPartial({
        config: PDA.config(), bet: b.publicKey, playerState: b.account.playerState,
        bankrollVault: PDA.bankrollVault(), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: b.account.rentPayer,
      }).signers([payer]).rpc();
      log(`  settled bet ${b.publicKey.toBase58()}`);
    } catch (e) {
      log(`  settle failed ${b.publicKey.toBase58()}: ${String(e).slice(0, 160)}`);
    }
    if (i % 20 === 19) {
      const c2 = await fetchConfig(program);
      await runRound(connection, program, payer, "jackpot", c2.jackpotRound, Math.floor(Date.now() / 1000), log);
      await runRound(connection, program, payer, "draw", c2.drawRound, Math.floor(Date.now() / 1000), log);
    }
  }

  // 3. epochs: seal drops, expire closed windows
  const epochs: any[] = await acc.epoch.all();
  for (const e of epochs) {
    const id = Number(e.account.id);
    if (e.account.closed) continue;
    if (now >= Number(e.account.expiresAt)) {
      try {
        await program.methods.expireEpoch().accountsPartial({ config: PDA.config(), epoch: e.publicKey }).signers([payer]).rpc();
        log(`  epoch ${id} expired: unclaimed reserve returned to the pool`);
      } catch (err) {
        log(`  expire ${id}: ${String(err).slice(0, 160)}`);
      }
      continue;
    }
    if (e.account.dropState === 1) await sealDrop(program, payer, id, log);
  }
  for (const f of epochFiles) {
    const ep = epochs.find((e) => Number(e.account.id) === f.epoch);
    if (!ep || ep.account.closed || now >= Number(ep.account.expiresAt)) continue;
    await claimAll(connection, program, payer, f, log);
    await deliverDrops(connection, program, payer, f, log);
  }

  // 4. jackpot rounds refunded because nobody settled in time: pay every entry back
  for (const r of await acc.jackpotRound.all()) {
    if (r.account.state !== 3) continue;
    const id = Number(r.account.id);
    for (let i = 0; i < r.account.entries; i++) {
      const entry = await acc.jackpotEntry.fetchNullable(PDA.jpEntry(id, i));
      if (!entry) continue;
      try {
        await program.methods.closeJackpotEntry().accountsPartial({
          round: r.publicKey, playerState: PDA.player(entry.player), entry: PDA.jpEntry(id, i), rentPayer: entry.rentPayer,
        }).signers([payer]).rpc();
        log(`  jackpot ${id} entry ${i} refunded`);
      } catch (err) {
        log(`  refund ${id}/${i}: ${String(err).slice(0, 160)}`);
      }
    }
  }

  // 5. Moon Wars: start joined matches (their seed block must be used while it is still in the
  //    SlotHashes window), award matches whose turn timer ran out, pay out finished ones
  for (const w of await acc.war.all()) {
    const key = w.publicKey.toBase58();
    try {
      if (w.account.state === 1) {
        await program.methods.startWar().accountsPartial({ war: w.publicKey, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).signers([payer]).rpc();
        log(`  war ${key} started (or re-committed to a fresh block)`);
      } else if (w.account.state === 2 && Math.floor(Date.now() / 1000) > Number(w.account.deadline)) {
        await program.methods.claimWarTimeout().accountsPartial({ war: w.publicKey }).signers([payer]).rpc();
        log(`  war ${key}: turn timer ran out`);
      }
      const cur = await acc.war.fetchNullable(w.publicKey);
      if (cur && cur.state === 3) {
        await program.methods.settleWar().accountsPartial({
          config: PDA.config(), war: w.publicKey, creatorState: PDA.player(cur.creator), opponentState: PDA.player(cur.opponent),
          rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: ARCHITECT, rentPayer: cur.rentPayer,
        }).signers([payer]).rpc();
        log(`  war ${key} paid out`);
      }
    } catch (err) {
      log(`  war ${key}: ${String(err).slice(0, 160)}`);
    }
  }

  // 6. Predictions: lock / settle the rounds that are due (NotReady = no swap since the target time,
  //    retried next pass), pay every entry of a resolved round, then close the round
  for (const r of await acc.predRound.all()) {
    const id = Number(r.account.id);
    const t = Math.floor(Date.now() / 1000);
    try {
      if (r.account.state === 0 && t >= Number(r.account.lockTs)) {
        await program.methods.lockPrediction().accountsPartial({ round: r.publicKey, observation: XDEX_XNT_OBSERVATION }).signers([payer]).rpc();
        log(`  prediction ${id} locked`);
      } else if (r.account.state === 1 && t >= Number(r.account.endTs)) {
        await program.methods.settlePrediction().accountsPartial({
          config: PDA.config(), round: r.publicKey, observation: XDEX_XNT_OBSERVATION, rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: ARCHITECT,
        }).signers([payer]).rpc();
        log(`  prediction ${id} settled`);
      }
    } catch (err) {
      log(`  prediction ${id}: ${String(err).slice(0, 160)}`);
    }
    const cur = await acc.predRound.fetch(r.publicKey);
    if (cur.state !== 2 && cur.state !== 3) continue;
    // PredEntry layout: disc 8 | round u64 | player 32
    const entries: any[] = await acc.predEntry.all([{ memcmp: { offset: 8, bytes: bs58.encode(u64(id)) } }]);
    for (const e of entries) {
      try {
        await program.methods.claimPrediction().accountsPartial({
          config: PDA.config(), round: r.publicKey, entry: e.publicKey, playerState: PDA.player(e.account.player), rentPayer: e.account.rentPayer,
        }).signers([payer]).rpc();
        log(`  prediction ${id}: paid ${e.account.player.toBase58()}`);
      } catch (err) {
        log(`  prediction ${id} claim: ${String(err).slice(0, 160)}`);
      }
    }
    const after = await acc.predRound.fetch(r.publicKey);
    if (after.claimed === after.entries) {
      try {
        await program.methods.closePredictionRound().accountsPartial({ config: PDA.config(), round: r.publicKey, rewardVault: PDA.rewardVault(), rentPayer: after.rentPayer }).signers([payer]).rpc();
        log(`  prediction ${id} closed`);
      } catch (err) {
        log(`  prediction ${id} close: ${String(err).slice(0, 160)}`);
      }
    }
  }
}

/** Closes an ended round and settles it in the SAME call (waits for the drawing slot). */
async function runRound(connection: Connection, program: anchor.Program, payer: Keypair, kind: "jackpot" | "draw", roundId: anchor.BN, now: number, log: (s: string) => void) {
  const acc = program.account as any;
  const roundPk = kind === "jackpot" ? PDA.jackpot(roundId.toNumber()) : PDA.draw(roundId.toNumber());
  let round = await (kind === "jackpot" ? acc.jackpotRound : acc.drawRound).fetchNullable(roundPk);
  if (!round) return;
  try {
    if (round.state === 0 && Number(round.endTs) !== 0 && now >= Number(round.endTs)) {
      if (kind === "jackpot") {
        await program.methods.drawJackpot().accountsPartial({ config: PDA.config(), round: roundPk, firstPlayerState: PDA.player(round.firstPlayer) }).signers([payer]).rpc();
      } else {
        await program.methods.drawDraw().accountsPartial({ config: PDA.config(), round: roundPk }).signers([payer]).rpc();
      }
      log(`  ${kind} ${roundId} closed`);
      round = await (kind === "jackpot" ? acc.jackpotRound : acc.drawRound).fetch(roundPk);
    }
    if (round.state !== 1) return;
    // wait (≤ ~15 s) until the drawing slot exists, then settle right away
    let slot = BigInt(await connection.getSlot("confirmed"));
    for (let i = 0; i < 30 && slot <= BigInt(round.targetSlot.toString()); i++) {
      await sleep(500);
      slot = BigInt(await connection.getSlot("confirmed"));
    }
    if (slot <= BigInt(round.targetSlot.toString())) return;
    const h = await slotHashAtOrAfter(connection, BigInt(round.targetSlot.toString()));
    const total = BigInt((kind === "jackpot" ? round.total : round.totalWeight).toString());
    let entryPk: PublicKey | undefined;
    let winner: PublicKey | undefined;
    if (h) {
      const t = randomU64(h, roundPk.toBuffer(), u64(BigInt(round.id.toString()))) % total;
      const pks = Array.from({ length: round.entries }, (_, i) => (kind === "jackpot" ? PDA.jpEntry(roundId.toNumber(), i) : PDA.drawEntry(roundId.toNumber(), i)));
      const entries = await (kind === "jackpot" ? acc.jackpotEntry : acc.drawEntry).fetchMultiple(pks);
      entries.forEach((e: any, i: number) => {
        if (!e) return;
        const start = BigInt(e.start.toString());
        const size = BigInt((kind === "jackpot" ? e.amount : e.weight).toString());
        if (t >= start && t < start + size) {
          entryPk = pks[i];
          winner = e.player;
        }
      });
    }
    // if the hash expired the program refunds the jackpot / sends the lottery prize to the reward pool; any entry is accepted
    entryPk = entryPk ?? (kind === "jackpot" ? PDA.jpEntry(roundId.toNumber(), 0) : PDA.drawEntry(roundId.toNumber(), 0));
    if (!winner) {
      const e0 = await (kind === "jackpot" ? acc.jackpotEntry : acc.drawEntry).fetch(entryPk);
      winner = e0.player;
    }
    if (kind === "jackpot") {
      await program.methods.settleJackpot().accountsPartial({
        config: PDA.config(), round: roundPk, entry: entryPk, winnerState: PDA.player(winner!), rewardVault: PDA.rewardVault(),
        drawVault: PDA.drawVault(), architect: ARCHITECT, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
      }).signers([payer]).rpc();
    } else {
      await program.methods.settleDraw().accountsPartial({
        config: PDA.config(), round: roundPk, entry: entryPk, winnerState: PDA.player(winner!), drawVault: PDA.drawVault(),
        rewardVault: PDA.rewardVault(), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
      }).signers([payer]).rpc();
    }
    log(`  ${kind} ${roundId} settled`);
  } catch (e) {
    log(`  ${kind} ${roundId}: ${String(e).slice(0, 200)}`);
  }
}
