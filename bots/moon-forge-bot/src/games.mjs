// Optional games, off by default, 18+ only and only where legal. You can lose the whole stake.
// Sealed Duel and sealed Moon Wars use the kit's flows (secrets written to the kit's store before each commitment);
// house games run only while the house keeper seat is live, as read from X1 on every tick. Every action is bounded by
// the stake cap, the number of games per day and a total loss budget measured on the wallets themselves.
import { GAMES_NOTICE } from './safety.mjs';

const XNT = 1e9;
export const KEEPER_MAX_IDLE_DAYS = 28;
export const KEEPER_MIN_BOND_XNT = 20;

/** Is the house keeper seat live? (the site's own test: armed, bonded, active within 28 days, no bond withdrawal announced). */
export function keeperSeatLive(k) {
  if (!k?.exists) return { live: false, why: k?.reason ?? 'no keeper seat' };
  if (!k.armed) return { live: false, why: k.reason ?? 'keeper not armed' };
  if (k.bondXnt < KEEPER_MIN_BOND_XNT) return { live: false, why: `keeper bond ${k.bondXnt} XNT below ${KEEPER_MIN_BOND_XNT}` };
  if (k.withdrawRequested) return { live: false, why: 'the keeper announced a bond withdrawal' };
  if (k.idleDays >= KEEPER_MAX_IDLE_DAYS) return { live: false, why: `keeper idle for ${k.idleDays.toFixed(1)} days` };
  return { live: true, why: null };
}

/**
 * May the bot play now, and with what stake? Pure. state: { rules, totalLamports, baselineLamports, playedToday }.
 * Returns { ok, why?, stakeXnt?, budgetLeftXnt? }.
 */
export function gamesGate(g, state) {
  if (!g.enabled) return { ok: false, why: 'games are off (games.enabled is false)' };
  if (g.ageConfirmed18Plus !== true) return { ok: false, why: 'games need games.ageConfirmed18Plus: true' };
  if (state.rules !== 3) return { ok: false, why: 'sealed Duel and Moon Wars need the final upgrade (not detected on X1)' };
  if (state.playedToday >= g.maxGamesPerDay) return { ok: false, why: `daily game count reached (${state.playedToday}/${g.maxGamesPerDay})` };
  const lost = state.baselineLamports === null ? 0 : Math.max(0, state.baselineLamports - state.totalLamports) / XNT;
  const left = g.lossBudgetXnt - lost;
  if (left <= 0) return { ok: false, why: `loss budget used (${lost.toFixed(4)} of ${g.lossBudgetXnt} XNT): games stop until you raise it or reset the baseline` };
  const stakeXnt = Math.min(g.maxStakeXnt, left);
  if (stakeXnt < 0.1) return { ok: false, why: `what is left of the loss budget (${left.toFixed(4)} XNT) is below the 0.1 XNT minimum stake` };
  return { ok: true, stakeXnt, budgetLeftXnt: left };
}

/** One games pass: finish what is open first, then at most one new game. */
export async function gamesTick({ mf, cfg, journal, live, log, tick }) {
  const g = cfg.games;
  const mode = live ? 'live' : 'dry-run';
  const line = (game, decision, reason) => log.decision({ tick, mode, game, decision, reason });
  if (!g.enabled) return;
  const rules = await mf.rulesNow();
  const wallet = BigInt(await mf.connection.getBalance(mf.me)) + BigInt(await mf.gameBalance());
  const st = journal.data.games;
  if (st.baselineLamports === null) { st.baselineLamports = Number(wallet); journal.save(); log.info(`games: loss baseline set at ${Number(wallet) / XNT} XNT (wallet + game balance). ${GAMES_NOTICE}`); }
  const day = new Date().toISOString().slice(0, 10);
  const playedToday = st.perDay[day] ?? 0;
  const gate = gamesGate(g, { rules, totalLamports: Number(wallet), baselineLamports: st.baselineLamports, playedToday });

  // 1. reveal the duels this wallet created once the joiner has opened (a creator that never reveals loses)
  if (g.duel.enabled && rules === 3) {
    for (const d of await mf.myDuels()) {
      if (!d.account.creator.equals(mf.me) || d.account.state !== 1 || d.account.opponentElement === 255) continue;
      if (!live) { line('duel', 'REVEAL', `would reveal ${d.publicKey.toBase58()}`); continue; }
      try { await mf.revealDuel(d.publicKey); line('duel', 'REVEAL', d.publicKey.toBase58()); } catch (e) { line('duel', 'ERROR', String(e?.message ?? e).slice(0, 160)); }
    }
  }
  if (!gate.ok) { line('any', 'WAIT', gate.why); return; }
  const stakeLamports = Math.floor(gate.stakeXnt * XNT);
  const count = () => { st.perDay[day] = playedToday + 1; journal.save(); };

  if (g.duel.enabled) {
    const open = (await mf.openDuels()).filter((d) => Number(d.account.stake) <= stakeLamports);
    if (open.length || g.duel.createWhenNone) {
      const target = open[0];
      if (!live) { line('duel', target ? 'JOIN' : 'CREATE', `would ${target ? `join ${target.publicKey.toBase58()}` : `create a duel for ${gate.stakeXnt} XNT`}`); return; }
      try {
        if (target) await mf.joinDuelSealed(target.publicKey, 'random'); else await mf.createDuelSealed(gate.stakeXnt, 'random');
        count(); line('duel', target ? 'JOIN' : 'CREATE', `stake within ${gate.stakeXnt} XNT; budget left ${gate.budgetLeftXnt.toFixed(4)} XNT`);
      } catch (e) { line('duel', 'ERROR', String(e?.message ?? e).slice(0, 160)); }
      return;
    }
  }
  if (g.wars.enabled) {
    const open = (await mf.openWars()).filter((w) => Number(w.account.stake) <= stakeLamports);
    if (open.length || g.wars.createWhenNone) {
      if (!live) { line('wars', open.length ? 'JOIN' : 'CREATE', `would ${open.length ? `join ${open[0].publicKey.toBase58()}` : `create a match for ${gate.stakeXnt} XNT`}`); return; }
      try {
        const war = open.length ? (await mf.joinWarSealed(open[0].publicKey)).war : (await mf.createWarSealed(gate.stakeXnt)).war;
        count();
        await mf.advanceStart(war, { wait: true });
        const done = await mf.playMatch(war, { log: (s) => log.info(`wars: ${s}`) });
        await mf.settleWar(war).catch(() => {});
        line('wars', 'DONE', done.draw ? 'draw: both stakes refunded' : done.winner.equals(mf.me) ? 'won' : 'lost');
      } catch (e) { line('wars', 'ERROR', String(e?.message ?? e).slice(0, 160)); }
      return;
    }
  }
  if (g.house.enabled) {
    const seat = keeperSeatLive(await mf.houseKeeper());
    if (!seat.live) { line('house', 'WAIT', `house games only while the keeper seat is live: ${seat.why}`); return; }
    const stake = Math.min(gate.stakeXnt, g.maxStakeXnt);
    if (!live) { line('house', 'BET', `would bet ${stake} XNT (fixed 2% edge)`); return; }
    try {
      const { bet } = await mf.placeBetV2(g.house.game, g.house.param, g.house.choice, stake);
      count();
      const r = await mf.waitBet(bet);
      line('house', 'DONE', `${r.state}${r.won !== undefined ? (r.won ? ' won' : ' lost') : ''}`);
    } catch (e) { line('house', 'ERROR', String(e?.message ?? e).slice(0, 160)); }
  }
}
