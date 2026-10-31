// Shared fixtures of the v3 unit tests (no network): the golden quote vectors, a week-so-far feed built from one of
// their worlds, and an offline MoonForge on the upgraded program's IDL whose send() captures the built instruction.
import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBundledIdl } from '../../idl.mjs';
import { MoonForge } from '../../moonforge.mjs';
import { globalOrder, HOUR } from '../../quote-v3.mjs';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const KIT = path.resolve(here, '..', '..');
export const REPO = path.resolve(KIT, '..', '..');
export const VECTORS_FILE = path.join(KIT, 'test', 'vectors', 'quote-v3.json');
export const EPOCH1_FILE = path.join(REPO, 'frontend', 'public', 'epochs', 'epoch-1.json');

let vectors = null;
export function loadVectors() {
  if (!vectors) vectors = JSON.parse(fs.readFileSync(VECTORS_FILE, 'utf8'));
  return vectors;
}
export const epoch1 = () => JSON.parse(fs.readFileSync(EPOCH1_FILE, 'utf8'));
export function prevOf(world) {
  if (world.prev === null) return null;
  if (world.prev === 'epoch-1') return epoch1();
  return loadVectors().prevFiles[world.prev];
}

/** Every burn of a world's inputs, in the engine's global order. */
export const burnsOf = (inputs) => inputs.chains.flatMap((c) => c.burns).sort(globalOrder);

/** The inputs of a world restricted to the burns strictly before `burn` in the global order. */
export function prefixInputs(inputs, burn) {
  return { ...inputs, chains: inputs.chains.map((c) => ({ ...c, burns: c.burns.filter((b) => globalOrder(b, burn) < 0) })) };
}

/**
 * A week-so-far feed (FEED CONTRACT of burn.mjs) for a world at time `now`: the burns before `now`, the current hour's
 * readings copied from a burn of the world (or given), and the previous file's identity.
 */
export function feedFromWorld(world, now, { readings = null, statuses = {}, route = null, xdex = null, flags = null } = {}) {
  const prev = prevOf(world);
  const hour = Math.floor(now / HOUR);
  const any = burnsOf(world.inputs).find((b) => b.priceSource === 'candles' && b.xntSource === 'candles');
  const r = readings ?? { medianE18: any.medianE18, lastCloseE18: any.lastCloseE18, priceSource: 'candles', xntMedianE18: any.xntMedianE18, xntLastCloseE18: any.xntLastCloseE18, xntSource: 'candles' };
  return {
    kind: 'week-so-far', version: 1, programId: world.inputs.programId, rules: 3, epoch: world.inputs.epoch, asOf: now,
    prevEpoch: prev ? { epoch: prev.epoch, dataHash: prev.dataHash } : null,
    window: { startTs: world.inputs.window.startTs },
    freePool: { open: world.inputs.freePool.open ?? world.inputs.freePool.lamports },
    xnt: { twapE18: world.inputs.xnt.twapE18, apiE18: world.inputs.xnt.apiE18, current: { hour, medianE18: r.xntMedianE18, lastCloseE18: r.xntLastCloseE18, source: r.xntSource } },
    chains: world.inputs.chains.map((c) => ({
      chainId: c.chainId, name: c.name, portal: c.portal, status: statuses[c.chainId] ?? 'ok', market: c.market, liquidityNowMicro: c.liquidityNowMicro,
      burns: c.burns.filter((b) => b.timestamp < now), current: { hour, medianE18: r.medianE18, lastCloseE18: r.lastCloseE18, priceSource: r.priceSource },
      ...(route ? { route } : {}),
    })),
    ...(xdex ? { xdex } : {}),
    switchRefs: world.inputs.switchRefs ?? null,
    ...(flags ? { flags } : {}),
  };
}

/** A fixed, on-curve X1 address for generated fixtures (from a constant seed: not anyone's wallet). */
export const FIXTURE_X1 = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58();
/**
 * The inputs of the example week-so-far feed (test/vectors/gen-week-so-far.mjs): the first golden world that has a
 * previous epoch file, at least two chains with burns, and an hour (just after one of its burns) at which a Launchpad
 * burn (10^9, 10^8 or 10^7 XEN) gets a whole binding quote. Deterministic: the same vectors give the same fixture.
 */
export async function fixtureInputs() {
  const { quoteBurn } = await import('../../burn.mjs');
  for (const [i, w] of loadVectors().worlds.entries()) {
    if (w.prev === null || !w.expected || w.expected.shortfall) continue;
    const withBurns = w.inputs.chains.filter((c) => c.burns.length && BigInt(c.liquidityNowMicro) > 0n);
    if (withBurns.length < 2) continue;
    for (const b of burnsOf(w.inputs)) {
      const now = (Math.floor(b.timestamp / HOUR) + 1) * HOUR + 600;
      if (now > w.inputs.window.endTs) continue;
      const feed = feedFromWorld(w, now);
      for (const xen of [1_000_000_000n, 100_000_000n, 10_000_000n]) {
        const candidate = { chainId: b.chainId, amountWei: xen * 10n ** 18n, tier: 0, x1: FIXTURE_X1 };
        const q = quoteBurn({ feed, prev: prevOf(w), now, allowBelowMarket: true, ...candidate });
        if (q.ok && q.bindingNow > 0n && q.bindingNow === q.entitlement) return { feed, prev: prevOf(w), prevRef: { world: i, seed: w.seed ?? null, prev: w.prev }, candidate };
      }
    }
  }
  throw new Error('no world of the vectors fits the feed fixture');
}

/** A connection that answers nothing over the network (every RPC call is refused unless stubbed by `over`). */
export function offlineConnection(over = {}) {
  const c = new Connection('http://127.0.0.1:1', 'confirmed');
  c._rpcRequest = async (m) => { throw new Error(`offline test connection: ${m} not stubbed`); };
  c._rpcBatchRequest = async () => { throw new Error('offline test connection: batch not stubbed'); };
  return Object.assign(c, over);
}

export function tempDir(tag = 'mf-kit') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
}

/**
 * A MoonForge on the bundled v3 IDL (or `idl`) whose send() builds the instruction offline and records it instead of
 * sending: mf.sent = [{ name, ix, opts }]. `stubs` replaces methods (config, chainTime, ...) and `acc` the account clients.
 */
export function offlineKit({ rules = 3, idl = loadBundledIdl('v3').idl, keypair = Keypair.generate(), stubs = {}, acc = null, connection = null, secretsDir = null } = {}) {
  const conn = connection ?? offlineConnection({
    getMinimumBalanceForRentExemption: async () => 1_000_000,
    getAccountInfo: async () => null,
    getSlot: async () => 1_000,
    getBlockTime: async () => 1_800_000_000,
  });
  const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(keypair), { commitment: 'confirmed' }));
  const warnings = [];
  const mf = new MoonForge(program, keypair, {
    detection: { rules, status: 'test', reasons: rules === 'unknown' ? ['test: unknown'] : [], deploySlot: null, at: Date.now() },
    onWarning: (t) => warnings.push(t), secretsDir: secretsDir ?? tempDir(),
  });
  mf.warnings = warnings;
  mf.sent = [];
  mf.send = async (builder, name, opts = {}) => {
    const ix = typeof builder.instruction === 'function' ? await builder.instruction() : (await builder.transaction()).instructions.at(-1);
    mf.sent.push({ name, ix, opts });
    return `SIG${mf.sent.length}`;
  };
  if (acc) mf.acc = acc;
  Object.assign(mf, stubs);
  return mf;
}

/** The IDL account names of instruction `name`, flattened in order (nested groups expanded). */
export function idlAccounts(idl, name) {
  const ix = idl.instructions.find((i) => i.name === name);
  if (!ix) throw new Error(`no instruction ${name} in the IDL`);
  const flat = (list) => list.flatMap((a) => (a.accounts ? flat(a.accounts) : [a]));
  return flat(ix.accounts);
}
/** The 8-byte Anchor discriminator of instruction `name` (sha256("global:" + name)[0..8]). */
export const disc = (name) => crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8).toString('hex');
export const key = (i, tag = 9) => { const b = new Uint8Array(32); b[0] = tag; b[1] = i & 255; b[31] = 3; return new PublicKey(b); };
export const BN = anchor.BN;
