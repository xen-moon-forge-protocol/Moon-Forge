// Read-only snapshot for an agent's decision loop: balances, reward pool, bankroll state, XNT price, open matches,
// and the notices in force (Moon Wars pause and fees, Predictions not offered, house-game edge, forging paused on the site).
//   AGENT_KEY=~/agent.json node examples/status.mjs        (any key works for reading)
//   X1_RPC_URLS=https://your-rpc,https://rpc.mainnet.x1.xyz   your own endpoint first, failover to the next (read only when RPC is unset)
import { Keypair } from '@solana/web3.js';
import { connect, errorMessage, loadKeypair } from '../moonforge.mjs';

try {
  // the key is loaded inside the try: errorMessage() prints a fixed line, never a stack with key material
  const keypair = process.env.AGENT_KEY ? loadKeypair(process.env.AGENT_KEY) : Keypair.generate();
  const mf = await connect({ rpc: process.env.RPC, keypair, idl: process.env.IDL });
  console.log(JSON.stringify(await mf.status(), null, 2)); // status().rpc is the serving endpoint's origin only
} catch (e) {
  console.error(`status: ${errorMessage(e)}`);
  process.exitCode = 1;
}
