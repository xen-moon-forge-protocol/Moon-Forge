#!/usr/bin/env node
// Moon Forge Bot: command line.
//   node bin/moon-forge-bot.mjs check  [--config config.json]          validate the config, print the notices and the chains
//   node bin/moon-forge-bot.mjs once   [--config ...] [--live] [--only burn,claims,games,artifacts]
//   node bin/moon-forge-bot.mjs run    [--config ...] [--live]         tick every tickSeconds until the kill switch or Ctrl+C
//   node bin/moon-forge-bot.mjs quote  --chain 10 --xen 1000000        one read-only quote
// Without --live nothing is ever signed or sent (dry run). The kill switch: create the file named in killSwitchFile,
// or set MFBOT_STOP=1.
import { loadConfig } from '../src/config.mjs';
import { createLogger, scrub } from '../src/log.mjs';
import { RISK_NOTICE, GAMES_NOTICE, killSwitchOn } from '../src/safety.mjs';
import { readPortalsFile, resolveChains } from '../src/chains.mjs';
import { startA2A } from '../src/a2a.mjs';

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('--') ? args[0] : 'check';
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt = null) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const live = flag('live');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { cfg, ok, errors, warnings, limits } = loadConfig(opt('config', 'config.json'), { live });
  const log = createLogger({ file: cfg.logFile });
  for (const w of warnings) log.warn(`config: ${w}`);
  if (!ok) { for (const e of errors) log.error(`config: ${e}`); process.exitCode = 2; return; }

  if (cmd === 'check') {
    console.log(`\n${RISK_NOTICE}\n`);
    if (cfg.games.enabled) console.log(`${GAMES_NOTICE}\n`);
    for (const c of resolveChains(cfg, readPortalsFile(cfg.portalsFile))) log.info(`chain ${c.name} (${c.chainId}): ${c.usable ? 'ready' : `skipped: ${c.why}`}`);
    log.info(`config ok; acceptRiskNotice=${cfg.acceptRiskNotice}; mode for once/run: ${live ? 'live' : 'dry-run (add --live to send)'}`);
    const stop = killSwitchOn(cfg);
    if (stop) log.warn(`kill switch on: ${stop}`);
    return;
  }

  const { createBot } = await import('../src/bot.mjs');
  const bot = await createBot({ cfg, limits, live, log });
  if (live) log.warn('LIVE mode: transactions will be signed and sent within the limits of the config');
  else log.info('dry run: nothing will be signed or sent');

  if (cmd === 'quote') {
    const r = await bot.quoteOnce({ chainId: Number(opt('chain', '10')), amountXen: opt('xen', '1000000') });
    console.log(JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    return;
  }
  const parts = opt('only') ? opt('only').split(',') : null;
  if (cmd === 'once') { await bot.runTick({ parts }); return; }
  if (cmd !== 'run') { log.error(`unknown command ${cmd} (check | once | run | quote)`); process.exitCode = 2; return; }

  let server = null;
  if (cfg.a2a.enabled) {
    const token = cfg.a2a.tokenEnv ? process.env[cfg.a2a.tokenEnv] || null : null;
    server = startA2A({
      host: cfg.a2a.host, port: cfg.a2a.port, token, allowActions: cfg.a2a.allowActions, log: log.info,
      handlers: { card: bot.card, status: bot.status, quote: bot.quoteOnce, plan: () => bot.runTick({ parts: ['burn'], dryRun: true }), tick: () => bot.runTick({ parts }) },
    });
    log.info(`A2A interface on ${cfg.a2a.host}:${cfg.a2a.port} (${token ? 'token required' : 'loopback only, no token'}; actions ${cfg.a2a.allowActions ? 'allowed within the limits' : 'off'})`);
  }
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; log.info('stopping after this tick'); });
  process.on('SIGTERM', () => { stopping = true; });
  while (!stopping) {
    try { await bot.runTick({ parts }); } catch (e) { log.error(`tick failed: ${String(e?.message ?? e).slice(0, 200)}`); }
    const stop = killSwitchOn(cfg);
    if (stop) { log.warn(`kill switch on (${stop}): exiting`); break; }
    for (let waited = 0; waited < cfg.tickSeconds * 1000 && !stopping; waited += 1000) await sleep(1000);
  }
  server?.close();
}

main().catch((e) => { console.error(`stopped: ${scrub(String(e?.message ?? e).slice(0, 300))}`); process.exitCode = 1; });
