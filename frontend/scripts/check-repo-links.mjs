#!/usr/bin/env node
/**
 * R7b: every link the site makes into this repository (github.com/…/Moon-Forge/blob|tree/main/<path>, the same with a
 * ${GITHUB_URL}-style template prefix, and raw.githubusercontent.com/…/Moon-Forge/main/<path>) must name a path that
 * exists in the checkout being built.
 *
 * In GitHub Actions the checkout holds only committed files, so a link to a document that is not on main (or not in
 * the same push as the frontend) fails the build instead of shipping a 404 on every games panel. Locally an existing
 * but untracked target is only a warning: commit it in the same push as the frontend.
 *
 *   node scripts/check-repo-links.mjs        (first steps of `npm run build`)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..');
const CI = !!process.env.GITHUB_ACTIONS;

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const sources = [
    ...walk(path.join(ROOT, 'src')).filter((f) => /\.(ts|tsx)$/.test(f)),
    ...['public/links.json', 'public/llms.txt', 'public/llms-full.txt', 'public/.well-known/security.txt', 'index.html']
        .map((f) => path.join(ROOT, f)).filter((f) => fs.existsSync(f)),
];

// "Moon-Forge/blob/main/x" (literal URL) or "}/blob/main/x" (template literal after ${GITHUB_URL} / ${PROJECT_LINKS.github} …)
const BLOB = /(?:Moon-Forge|\})\/(?:blob|tree)\/main\/([A-Za-z0-9._\-/]+)/g;
const RAW = /raw\.githubusercontent\.com\/xen-moon-forge-protocol\/Moon-Forge\/main\/([A-Za-z0-9._\-/]+)/g;

const targets = new Map(); // repo path -> first file that links it
for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of [BLOB, RAW]) {
        for (const m of text.matchAll(re)) {
            const p = m[1].replace(/[.\/]+$/, '');
            if (p && !targets.has(p)) targets.set(p, path.relative(ROOT, file));
        }
    }
}

const tracked = (p) => {
    try { return execSync(`git ls-files -- "${p}"`, { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0; } catch { return null; }
};

const missing = [];
const untracked = [];
for (const [p, from] of [...targets].sort()) {
    if (!fs.existsSync(path.join(REPO, p))) { missing.push(`${p} (linked from ${from})`); continue; }
    const t = tracked(p);
    if (t === false) untracked.push(`${p} (linked from ${from})`);
}

if (untracked.length) {
    const msg = `check-repo-links: ${untracked.length} linked path(s) exist here but are not committed; they must reach main in the same push as the frontend, or every link to them is a 404:\n  ${untracked.join('\n  ')}`;
    if (CI) { console.error(msg); process.exit(1); }
    console.warn(`WARNING ${msg}`);
}
if (missing.length) {
    console.error(`check-repo-links: ${missing.length} linked path(s) do not exist in this checkout (the link would be a 404 on GitHub):\n  ${missing.join('\n  ')}`);
    process.exit(1);
}
console.log(`check-repo-links ok: ${targets.size} repository paths linked by the site exist in this checkout${untracked.length ? ` (${untracked.length} not committed yet, see the warning)` : ''}`);
