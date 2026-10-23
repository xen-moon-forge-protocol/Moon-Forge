// T9-37 supply-chain check, run before every build (`npm run build` and CI): the program id pinned in
// src/lib/constants.ts must equal the bundled IDL's address, public/links.json → verify.programId and the
// id the agent card advertises. src/lib/constants.ts repeats the same check at load time in the browser.
// Usage: node scripts/check-program-id.mjs   (exit 1 on any mismatch; no dependencies)
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const src = read('../src/lib/constants.ts');
const pin = /PROGRAM_ID_B58 = '([1-9A-HJ-NP-Za-km-z]{32,44})'/.exec(src)?.[1];
const idl = JSON.parse(read('../src/idl/moon_forge.json'));
const links = JSON.parse(read('../public/links.json'));
const card = read('../public/agent-card.json');
const wellKnownCard = read('../public/.well-known/agent-card.json');

const bad = [];
if (!pin) bad.push('no PROGRAM_ID_B58 pin in src/lib/constants.ts');
if (idl.address !== pin) bad.push(`src/idl/moon_forge.json address ${idl.address} != pin ${pin}`);
if (links.verify?.programId !== pin) bad.push(`public/links.json verify.programId ${links.verify?.programId} != pin ${pin}`);
if (!card.includes(pin)) bad.push('public/agent-card.json does not mention the pinned program id');
if (!wellKnownCard.includes(pin)) bad.push('public/.well-known/agent-card.json does not mention the pinned program id');
const foreign = new Set([...(card + wellKnownCard).matchAll(/"programId"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/g)].map((m) => m[1]).filter((id) => id !== pin));
if (foreign.size) bad.push(`agent card names another programId: ${[...foreign].join(', ')}`);

if (bad.length) {
    console.error('check-program-id FAILED:\n  ' + bad.join('\n  '));
    process.exit(1);
}
console.log(`check-program-id ok: ${pin} (constants.ts = idl.address = links.json = agent card)`);
