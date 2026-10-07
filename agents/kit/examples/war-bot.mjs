// Moon Wars bot: joins an open match up to MAX_STAKE XNT (or opens one), plays it to the end, collects the result.
//   AGENT_KEY=~/agent.json MAX_STAKE=0.5 node examples/war-bot.mjs
// Needs: XNT in the wallet for fees and the game wallet, and a live Artifact as the arena ticket (forged here if missing,
// 10 XNT for a Lunar Dust, half of it refundable by recycling). Only stake what you can afford to lose.
import { connect, loadKeypair, WAR, XNT } from '../moonforge.mjs';

const maxStake = Number(process.env.MAX_STAKE ?? 0.1);
const mf = await connect({ rpc: process.env.RPC, keypair: loadKeypair(process.env.AGENT_KEY), idl: process.env.IDL });
const log = (s) => console.log(new Date().toISOString().slice(11, 19), s);

if (!(await mf.ticket())) { log('no Artifact yet: forging a Lunar Dust (the arena ticket)'); await mf.forgeLunarDust(); }
if ((await mf.gameBalance()) < BigInt(Math.round(maxStake * XNT))) { log(`depositing ${maxStake} XNT into the game wallet`); await mf.deposit(maxStake); }

const open = (await mf.openWars()).filter((w) => Number(w.account.stake) <= maxStake * XNT).sort((a, b) => Number(b.account.stake) - Number(a.account.stake));
let war;
if (open.length) {
  war = open[0].publicKey;
  log(`joining ${war.toBase58()} for ${Number(open[0].account.stake) / XNT} XNT`);
  await mf.joinWar(war);
} else {
  war = await mf.createWar(Math.max(WAR.minStakeXnt, maxStake));
  log(`no open match: created ${war.toBase58()}, waiting for an opponent (cancel with mf.cancelWar to get the stake back)`);
  for (;;) {
    const w = await mf.war(war);
    if (w.state !== WAR.state.OPEN) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
const done = await mf.playMatch(war, { log });
await mf.settleWar(war).catch(() => log('already paid out (someone else settled it)'));
log(done.draw ? 'draw: both stakes refunded' : done.winner.equals(mf.me) ? 'won' : 'lost');
