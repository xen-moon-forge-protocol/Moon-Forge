// A dead-man watch for an agent's operator (npm run watch): every few minutes it reads, read-only, what can go wrong
// without anyone noticing, and prints one JSON line per check with its alarms:
//   oracle-late       no epoch published for more than 8 days (payouts are late or paused; weeks without burns publish nothing)
//   rules-changed     the program's rules changed since the watch started (e.g. the final upgrade went live: review the kit)
//   rules-unknown     the program is mid-upgrade or unreadable: the kit refuses every transaction until it is clear
//   program-deployed  the program's last-deploy slot changed (an upgrade transaction landed)
//   kit-outdated      this kit is older than the agent card's minKitVersion (only with --card)
//   card-unreadable   the agent card could not be fetched or parsed, so the minimum is unknown (only with --card)
//   wallet-low        the agent wallet holds less than --min-xnt (default 0.05 XNT, the fee reserve)
//   rpc               the chain could not be read for --max-misses checks in a row
// Nothing is signed or sent; any key works (a throwaway one by default).
//
//   node examples/watch.mjs                       loop every 10 minutes
//   node examples/watch.mjs --once                one check; exit code 2 when an alarm is raised (for cron)
//   AGENT_KEY=~/agent.json node examples/watch.mjs --min-xnt 0.2 --interval 5
//   node examples/watch.mjs --card                also compare the kit version with the agent card (HTTPS fetch of the site)
import { pathToFileURL } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { AGENT_CARD_URL, checkKitVersion, connect, errorMessage, fetchAgentCard, KIT_VERSION, loadKeypair } from '../moonforge.mjs';

const DAY = 86_400;

/**
 * The alarms of one reading against the first one. `reading`: { ok, error?, rules, deploySlot, oracle: { state, ageHours },
 * walletXnt, kit: { ok, text } | null }; `first`: the watch's first good reading; `misses`: consecutive failed reads.
 */
export function evaluate(reading, first, { minXnt = 0.05, misses = 0, maxMisses = 3 } = {}) {
  const alarms = [];
  if (!reading.ok) {
    if (misses >= maxMisses) alarms.push({ code: 'rpc', text: `the chain could not be read ${misses} times in a row (${reading.error ?? 'no answer'})` });
    return alarms;
  }
  if (reading.oracle?.state === 'late') alarms.push({ code: 'oracle-late', text: `the last epoch was published ${(reading.oracle.ageHours / 24).toFixed(1)} days ago (more than 8): payouts are late or paused` });
  if (reading.rules === 'unknown') alarms.push({ code: 'rules-unknown', text: 'the program is mid-upgrade or unreadable: the kit refuses every transaction until it is clear' });
  if (first && reading.rules !== first.rules) alarms.push({ code: 'rules-changed', text: `the program rules changed from ${first.rules} to ${reading.rules}: review the kit and its notices before sending anything` });
  if (first && first.deploySlot !== null && reading.deploySlot !== null && reading.deploySlot !== first.deploySlot) alarms.push({ code: 'program-deployed', text: `the program was deployed again (last-deploy slot ${first.deploySlot} -> ${reading.deploySlot})` });
  if (reading.kit && !reading.kit.ok) alarms.push({ code: reading.kit.unreadable ? 'card-unreadable' : 'kit-outdated', text: reading.kit.text });
  if (typeof reading.walletXnt === 'number' && reading.walletXnt < minXnt) alarms.push({ code: 'wallet-low', text: `the agent wallet holds ${reading.walletXnt} XNT, less than ${minXnt} XNT` });
  return alarms;
}

async function readOnce(mf, { card }) {
  try {
    await mf.refreshRules();
    const [cfg, now, lamports] = await Promise.all([mf.config(), mf.chainTime(), mf.connection.getBalance(mf.me)]);
    let kit = null;
    if (card) {
      // an unreadable card is an alarm of its own, never a pass: the minimum cannot be checked
      const c = await fetchAgentCard(AGENT_CARD_URL).catch(() => null);
      kit = c ? checkKitVersion(c, KIT_VERSION) : { ok: false, unreadable: true, text: 'the agent card could not be read, so the kit version cannot be checked against its minimum' };
    }
    return { ok: true, at: new Date(now * 1000).toISOString(), rules: mf.rules, deploySlot: mf.detection?.deploySlot ?? null, oracle: mf.oracleState(cfg, now), walletXnt: lamports / 1e9, kit };
  } catch (e) {
    return { ok: false, at: new Date().toISOString(), error: errorMessage(e).slice(0, 200) };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
  const once = args.includes('--once');
  const intervalMin = Number(opt('--interval', '10'));
  const minXnt = Number(opt('--min-xnt', '0.05'));
  const maxMisses = Number(opt('--max-misses', '3'));
  const keypair = process.env.AGENT_KEY ? loadKeypair(process.env.AGENT_KEY) : Keypair.generate();
  const mf = await connect({ rpc: process.env.RPC, keypair, onWarning: (t) => console.error(JSON.stringify({ warning: t })) });
  let first = null, misses = 0;
  for (;;) {
    const r = await readOnce(mf, { card: args.includes('--card') });
    misses = r.ok ? 0 : misses + 1;
    if (r.ok && !first) first = r;
    const alarms = evaluate(r, first, { minXnt, misses, maxMisses });
    console.log(JSON.stringify({ ...r, alarms }));
    if (once) { process.exitCode = alarms.length ? 2 : r.ok ? 0 : 1; return; }
    await new Promise((res) => setTimeout(res, Math.max(1, intervalMin) * 60_000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`watch: ${errorMessage(e)}`); process.exitCode = 1; });
}
export { DAY };
