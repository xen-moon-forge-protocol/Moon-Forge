// Assembly: builds the bot from a validated config and runs ticks. Every network dependency is created here, so the
// modules above stay testable with fakes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { burnTick } from './burner.mjs';
import { claimTick } from './claimer.mjs';
import { gamesTick } from './games.mjs';
import { artifactsTick } from './artifacts.mjs';
import { readPortalsFile, resolveChains } from './chains.mjs';
import { Journal } from './journal.mjs';
import { jsonRpc } from './evm-rpc.mjs';
import { ethersKey } from './evm-ethers.mjs';
import { evmKeyFrom, killSwitchOn, readSecret } from './safety.mjs';
import { toUnits, XEN_DECIMALS } from './config.mjs';
import { burnXen, EpochSource, fetchWeekFeed, loadClient, quoteBurn, readLastPublishTs, SITE_URL } from './kit.mjs';
import { kitOverrides, judgeQuote, xntPerBillionXen } from './strategy.mjs';

export const BOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CARD_FILE = path.join(BOT_DIR, 'agent-card.json');

/** A throwaway X1 keypair for read-only connections (dry runs without an X1 key): seed ‖ public key, 64 bytes. */
function readOnlyKeypairBytes() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const d = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const x = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return Uint8Array.from([...d, ...x]);
}

function epochSource(cfg) {
  if (!cfg.epochs || cfg.epochs === 'site') return new EpochSource({ url: `${SITE_URL}epochs/` });
  return /^https:\/\//.test(cfg.epochs) ? new EpochSource({ url: cfg.epochs }) : new EpochSource({ dir: path.resolve(cfg.epochs) });
}

export async function createBot({ cfg, limits, live, log }) {
  const chains = resolveChains(cfg, readPortalsFile(cfg.portalsFile));
  const journal = new Journal(cfg.stateFile);
  const epochs = epochSource(cfg);
  const rpcs = new Map();
  const rpcFor = (c) => { if (!rpcs.has(c.chainId)) rpcs.set(c.chainId, jsonRpc(c.settings.rpcs)); return rpcs.get(c.chainId); };

  let key = null;
  const evmSecret = readSecret(cfg.keys.evm);
  if (live && cfg.burn.enabled) {
    if (!evmSecret) throw new Error(`live burns need the EVM key: keys.evm.file or the ${cfg.keys.evm.env} environment variable`);
    key = await ethersKey(evmKeyFrom(evmSecret));
  }
  const walletAddress = key?.address ?? (cfg.evmAddress || null);

  // X1: the kit client, for claims, games, Artifacts, and the destination and oracle checks of a live burn
  let mf = null;
  const needX1 = cfg.claims.enabled || cfg.games.enabled || cfg.artifacts.alerts || cfg.artifacts.recycle.enabled || cfg.artifacts.listing.enabled || (live && cfg.burn.enabled);
  if (needX1) {
    const kit = await loadClient();
    const x1Secret = readSecret(cfg.keys.x1);
    const actsOnX1 = live && (cfg.claims.enabled || cfg.games.enabled || cfg.artifacts.recycle.enabled || cfg.artifacts.listing.enabled);
    if (actsOnX1 && !x1Secret) throw new Error(`live claims, games or Artifact actions need an X1 key: keys.x1.file or the ${cfg.keys.x1.env} environment variable`);
    const keypair = kit.loadKeypair(x1Secret ?? readOnlyKeypairBytes());
    mf = await kit.connect({ rpcs: cfg.x1Rpcs.length ? cfg.x1Rpcs : undefined, keypair, epochs: epochs, onWarning: (w) => log.warn(`kit: ${w}`) });
    if (!x1Secret) log.info('X1: read-only (no X1 key configured): claims, games and Artifact actions are planned, never sent');
    mf.readOnly = !x1Secret;
  }

  const deps = {
    getFeed: () => fetchWeekFeed(cfg.feedUrl),
    getPrev: (feed) => epochs.epoch(Number(feed.epoch) - 1),
    now: () => Math.floor(Date.now() / 1000),
    quote: quoteBurn,
    burn: burnXen,
    rpcFor,
    key,
    walletAddress,
    x1Connection: mf?.connection ?? null,
    readOracle: mf ? async () => ({ lastPublishTs: await readLastPublishTs(mf.connection) }) : null,
    killSwitch: () => killSwitchOn(cfg),
  };

  let tick = 0, last = null;
  async function runTick({ parts = null, dryRun = false } = {}) {
    tick += 1;
    const send = live && !dryRun;
    const want = (p) => (parts ? parts.includes(p) : true);
    const stop = killSwitchOn(cfg);
    const summary = { tick, at: new Date().toISOString(), mode: send ? 'live' : 'dry-run', stopped: !!stop };
    if (cfg.burn.enabled && want('burn')) {
      const r = await burnTick({ cfg, limits: limits.burn, chains, journal, log, live: send, tick, deps });
      summary.burn = r.evaluations.map((e) => ({ chainId: e.chainId, decision: e.decision, reason: e.reason, amountXen: e.amountWei?.toString(), quoteXnt: e.quote?.bindingNowXnt }));
    }
    if (stop) { log.warn(`kill switch on (${stop}): nothing else runs`); last = summary; return summary; }
    const x1Send = send && mf && !mf.readOnly;
    const guard = async (name, fn) => { try { return await fn(); } catch (e) { log.warn(`${name}: ${String(e?.message ?? e).slice(0, 200)}`); return null; } };
    if (mf && cfg.claims.enabled && want('claims')) summary.claims = await guard('claims', () => claimTick({ mf, cfg, live: x1Send, log, tick }));
    if (mf && cfg.games.enabled && want('games')) await guard('games', () => gamesTick({ mf, cfg, journal, live: x1Send, log, tick }));
    if (mf && want('artifacts') && (cfg.artifacts.alerts || cfg.artifacts.recycle.enabled || cfg.artifacts.listing.enabled)) await guard('artifacts', () => artifactsTick({ mf, cfg, journal, live: x1Send, log, tick }));
    last = summary;
    return summary;
  }

  /** A read-only quote for the A2A interface and the `quote` command. */
  async function quoteOnce({ chainId, amountXen }) {
    const feed = await fetchWeekFeed(cfg.feedUrl);
    const prev = Number(feed.epoch) > 1 ? await epochs.epoch(Number(feed.epoch) - 1) : null;
    const q = quoteBurn({ feed, prev, chainId, amountWei: toUnits(amountXen, XEN_DECIMALS, 'amountXen'), tier: cfg.burn.tier, x1: cfg.x1Destination, ...kitOverrides(cfg) });
    return { ok: q.ok, refusals: q.refusals, quoteXnt: q.bindingNowXnt ?? null, xntPer1e9Xen: xntPerBillionXen(q), sellXnt: q.marketRouteXnt ?? null, tranche: q.tranche ?? null, ruleVerdict: judgeQuote(q, cfg.burn.rule), notices: q.notices };
  }

  return {
    chains, journal, mf, runTick, quoteOnce,
    status: () => ({ mode: live ? 'live' : 'dry-run', killSwitch: killSwitchOn(cfg), chains: chains.map((c) => ({ chainId: c.chainId, name: c.name, usable: c.usable, why: c.why })), last }),
    card: () => JSON.parse(fs.readFileSync(CARD_FILE, 'utf8')),
  };
}
