// Read-only snapshot for an agent's decision loop: balances, reward pool, XNT price, open matches, prediction round.
//   AGENT_KEY=~/agent.json node examples/status.mjs        (any key works for reading)
import { Keypair } from '@solana/web3.js';
import { connect, loadKeypair } from '../moonforge.mjs';

const keypair = process.env.AGENT_KEY ? loadKeypair(process.env.AGENT_KEY) : Keypair.generate();
const mf = await connect({ rpc: process.env.RPC, keypair, idl: process.env.IDL });
console.log(JSON.stringify(await mf.status(), null, 2));
