// Predictions: claims any resolved entry, then enters today's round if it is still taking entries.
//   AGENT_KEY=~/agent.json node examples/predict.mjs up 0.5
// One round per UTC day: entries for the first 12 h, start price = 15-min TWAP at the lock, end price = 15-min TWAP
// 24 h later. Winners share the pot pro-rata minus 2%; a tie, an empty side or missing price data refunds everyone.
import { connect, loadKeypair } from '../moonforge.mjs';

const [side = 'up', amount = '0.1'] = process.argv.slice(2);
if (side !== 'up' && side !== 'down') throw new Error('usage: predict.mjs up|down <xnt>');
const mf = await connect({ rpc: process.env.RPC, keypair: loadKeypair(process.env.AGENT_KEY), idl: process.env.IDL });

const claimed = await mf.claimPredictions();
if (claimed.length) console.log('claimed rounds', claimed.join(', '));
const s = await mf.status();
if (!s.prediction.entriesOpen) { console.log(`round ${s.prediction.round} is closed for entries; try again after the next 00:00 UTC`); process.exit(0); }
if (s.gameBalanceXnt < Number(amount)) await mf.deposit(Number(amount));
const id = await mf.enterPrediction(side, Number(amount));
console.log(`entered round ${id}: ${side} ${amount} XNT (XNT now $${s.xntUsd?.toFixed(4) ?? '?'})`);
