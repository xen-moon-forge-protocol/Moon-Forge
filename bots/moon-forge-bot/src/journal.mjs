// The journal: the bot's only memory between runs. One JSON file, written atomically (temp file + rename), holding what
// was burned per UTC day, every transaction the moment before it is broadcast, and the games' loss baseline. A crash
// between "about to send" and "sent" leaves an entry the next tick reconciles from the chain before doing anything else.
import fs from 'node:fs';
import path from 'node:path';

export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

const EMPTY = () => ({ version: 1, days: {}, sends: [], games: { baselineLamports: null, perDay: {} }, artifacts: { perDay: {} }, claims: { done: [] } });

export class Journal {
  constructor(file, { clock = () => Date.now() } = {}) {
    this.file = file ? path.resolve(file) : null;
    this.clock = clock;
    this.data = EMPTY();
    if (this.file && fs.existsSync(this.file)) {
      try { this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; } catch {
        throw new Error('journal: the state file is not valid JSON; fix or move it (the bot never guesses what was already sent)');
      }
    }
  }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    fs.renameSync(tmp, this.file);
  }
  /** Burn totals of today (UTC): { xenWei: bigint, burns: number }, overall and for one chain. */
  today(chainId = null) {
    const d = this.data.days[utcDay(this.clock())] ?? { xenWei: '0', burns: 0, perChain: {} };
    if (chainId === null) return { xenWei: BigInt(d.xenWei), burns: d.burns };
    const c = d.perChain?.[chainId] ?? { xenWei: '0', burns: 0 };
    return { xenWei: BigInt(c.xenWei), burns: c.burns };
  }
  recordBurn(chainId, amountWei) {
    const key = utcDay(this.clock());
    const d = this.data.days[key] ?? { xenWei: '0', burns: 0, perChain: {} };
    const c = d.perChain[chainId] ?? { xenWei: '0', burns: 0 };
    c.xenWei = (BigInt(c.xenWei) + BigInt(amountWei)).toString(); c.burns += 1;
    d.xenWei = (BigInt(d.xenWei) + BigInt(amountWei)).toString(); d.burns += 1;
    d.perChain[chainId] = c;
    this.data.days[key] = d;
    this.save();
  }
  /** Written before a broadcast: { id, chainId, kind, nonce, hash, state: 'signed' | 'broadcast' | 'mined' | 'failed' | 'dropped' }. */
  openSend(entry) {
    const e = { id: `${entry.chainId}-${entry.nonce}-${this.clock()}`, at: new Date(this.clock()).toISOString(), state: 'signed', ...entry };
    this.data.sends.push(e);
    this.save();
    return e;
  }
  updateSend(id, patch) {
    const e = this.data.sends.find((x) => x.id === id);
    if (e) { Object.assign(e, patch); this.save(); }
    return e;
  }
  /** Sends not known to be final on this chain: the guard refuses a new send while one exists. */
  unresolved(chainId) {
    return this.data.sends.filter((e) => e.chainId === chainId && (e.state === 'signed' || e.state === 'broadcast'));
  }
}
