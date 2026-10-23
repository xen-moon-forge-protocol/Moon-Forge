// Moon Wars bot: joins an open match up to MAX_STAKE XNT (or opens one), plays it to the end, collects the result.
//   AGENT_KEY=~/agent.json MAX_STAKE=0.5 node examples/war-bot.mjs
// Read before running:
// - The website has paused creating and joining real-XNT matches (its browser move key is underfunded). The program is
//   unchanged; this bot signs every move with your own key, so any match it makes is real and costs real XNT.
// - Costs: a Lunar Dust ticket (10 XNT, 5 back on recycle) if you hold no Artifact and set FORGE_TICKET=1; every move is a transaction with its
//   own network fee (about 0.00018 XNT per move at the kit's compute limits, 30-60 moves per match); the winner pays
//   the 2% rake. The creator moves first. 2 minutes per turn: a crash or a slow RPC loses the match and the stake.
// - Your opponent may be another automated agent. Only stake what you can afford to lose.
// - MAX_STAKE is a cap: the bot never stakes more. Below the 0.1 XNT minimum stake it does nothing.
import { connect, loadKeypair, WAR, XNT, errorMessage } from '../moonforge.mjs';

const log = (s) => console.log(new Date().toISOString().slice(11, 19), s);
const maxStake = Number(process.env.MAX_STAKE ?? WAR.minStakeXnt);

async function run() {
  // the key is loaded inside the try: errorMessage() prints a fixed line, never a stack with key material
  const mf = await connect({ rpc: process.env.RPC, keypair: loadKeypair(process.env.AGENT_KEY), idl: process.env.IDL });
  if (!(await mf.ticket())) {
    // spending 10 XNT (5 back on recycle) is never automatic: the operator has to ask for it
    if (process.env.FORGE_TICKET !== '1') { log('no Artifact in this wallet: set FORGE_TICKET=1 to forge a Lunar Dust ticket (10 XNT, 5 back on recycle), or transfer one in. Exiting.'); return; }
    log('no Artifact yet: forging a Lunar Dust (the arena ticket under the current rules; 10 XNT, 5 back on recycle)'); await mf.forgeLunarDust();
  }
  if ((await mf.gameBalance()) < BigInt(Math.round(maxStake * XNT))) { log(`depositing ${maxStake} XNT into the game wallet`); await mf.deposit(maxStake); }

  const open = (await mf.openWars()).filter((w) => Number(w.account.stake) <= maxStake * XNT).sort((a, b) => Number(b.account.stake) - Number(a.account.stake));
  let war;
  if (open.length) {
    war = open[0].publicKey;
    log(`joining ${war.toBase58()} for ${Number(open[0].account.stake) / XNT} XNT`);
    await mf.joinWar(war);
  } else {
    war = await mf.createWar(maxStake);
    log(`no open match: created ${war.toBase58()}, waiting for an opponent (cancel with mf.cancelWar to get the stake back)`);
    for (;;) {
      const w = await mf.war(war);
      if (w.state !== WAR.state.OPEN) break;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  const done = await mf.playMatch(war, { log });
  await mf.settleWar(war).catch((e) => log(`not settled by me: ${errorMessage(e)} (someone else may have settled it)`));
  log(done.draw ? 'draw: both stakes refunded' : done.winner.equals(mf.me) ? 'won' : 'lost');
}

if (!Number.isFinite(maxStake) || maxStake < WAR.minStakeXnt) {
  log(`MAX_STAKE is below the ${WAR.minStakeXnt} XNT minimum stake of a match: nothing created or joined`);
  process.exitCode = 1;
} else {
  try {
    await run();
  } catch (e) {
    log(`stopped: ${errorMessage(e)}`);
    process.exitCode = 1;
  }
}
