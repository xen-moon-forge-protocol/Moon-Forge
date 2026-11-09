// Logging: one line per event, UTC time first. Every line passes through scrub() so that a key, a seed or an RPC URL
// with an API key in it never reaches the console or a log file, even when an error message quotes one.
import fs from 'node:fs';
import path from 'node:path';

const URL_RE = /\b(?:https?|wss?):\/\/[^\s'"<>()]+/gi;
const LONG_HEX_RE = /\b(?:0x)?[0-9a-fA-F]{64,}\b/g; // EVM private keys and 64-byte secrets in hex
const LONG_B58_RE = /\b[1-9A-HJ-NP-Za-km-z]{80,}\b/g; // base58 64-byte secret keys (87-88 characters)
const BYTE_ARRAY_RE = /\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/g; // JSON byte-array keypairs
const MNEMONIC_RE = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g; // 12-24 lowercase words in a row

/** Removes anything that looks like key material and shortens URLs to their origin. */
export function scrub(text) {
  return String(text)
    .replace(BYTE_ARRAY_RE, '[redacted bytes]')
    .replace(LONG_HEX_RE, (m) => (m.length === 66 && m.startsWith('0x') ? m : '[redacted hex]')) // a 0x + 64 tx hash stays readable
    .replace(LONG_B58_RE, '[redacted]')
    .replace(MNEMONIC_RE, '[redacted words]')
    .replace(URL_RE, (u) => { try { return new URL(u).origin; } catch { return '(url)'; } });
}

/** A logger: log.info / log.warn / log.decision; `sink` collects lines in tests. */
export function createLogger({ file = null, quiet = false, sink = null, clock = () => new Date() } = {}) {
  if (file) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const write = (level, msg) => {
    const line = `${clock().toISOString().replace(/\.\d{3}Z$/, 'Z')} ${level.padEnd(8)} ${scrub(msg)}`;
    if (sink) sink.push(line);
    if (!quiet) (level === 'WARN' || level === 'ERROR' ? console.error : console.log)(line);
    if (file) fs.appendFileSync(file, `${line}\n`);
    return line;
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
    /** One decision line per chain per tick: `decision` is a flat object printed as key=value pairs. */
    decision: (d) => write('DECISION', Object.entries(d).filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${typeof v === 'string' && /\s/.test(v) ? JSON.stringify(v) : v}`).join(' ')),
  };
}
