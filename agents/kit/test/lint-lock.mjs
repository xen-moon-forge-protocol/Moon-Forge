// Lockfile check with no dependencies (replaces `npx lockfile-lint`, which downloaded unpinned packages and ran their
// install scripts on the machine that holds the agent key). It enforces what the kit's supply-chain note promises:
//   - every installed package comes from https://registry.npmjs.org, at the tarball URL of its own name and version;
//   - every package carries a sha512 integrity hash (npm ci then refuses a tarball that does not match it);
//   - package.json dependencies and overrides are exact versions (no ranges, tags, URLs or git sources).
//   node test/lint-lock.mjs            (npm run lint:lock)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org/';
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Problems found in a parsed package-lock.json (v2/v3) and its package.json; an empty list means it passes. */
export function lintLock(lock, pkg = {}) {
  const problems = [];
  if (lock?.lockfileVersion !== 2 && lock?.lockfileVersion !== 3) problems.push(`lockfileVersion ${lock?.lockfileVersion}: expected 2 or 3 (npm 7+)`);
  for (const [section, deps] of [['dependencies', pkg.dependencies], ['devDependencies', pkg.devDependencies], ['overrides', pkg.overrides]]) {
    for (const [name, spec] of Object.entries(deps ?? {})) {
      if (typeof spec !== 'string' || !EXACT.test(spec)) problems.push(`package.json ${section}.${name} = ${JSON.stringify(spec)}: not an exact version`);
    }
  }
  for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
    if (!key) continue; // the root project
    if (entry.link) { problems.push(`${key}: a linked (local) package`); continue; }
    const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const base = name.split('/').pop();
    const expected = `${REGISTRY}${name}/-/${base}-${entry.version}.tgz`;
    if (!entry.resolved) problems.push(`${key}: no "resolved" URL`);
    else {
      let url = null;
      try { url = new URL(entry.resolved); } catch { /* reported below */ }
      if (!url) problems.push(`${key}: "resolved" is not a URL`);
      else if (url.protocol !== 'https:') problems.push(`${key}: not HTTPS (${url.protocol})`);
      else if (url.host !== 'registry.npmjs.org') problems.push(`${key}: host ${url.host} is not the npm registry`);
      else if (entry.resolved !== expected) problems.push(`${key}: resolved ${entry.resolved} does not match its name and version (${expected})`);
    }
    if (!entry.integrity) problems.push(`${key}: no integrity hash`);
    else if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)) problems.push(`${key}: integrity is not a sha512 hash`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const kit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const lock = JSON.parse(fs.readFileSync(path.join(kit, 'package-lock.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(kit, 'package.json'), 'utf8'));
  const problems = lintLock(lock, pkg);
  const count = Object.keys(lock.packages ?? {}).filter(Boolean).length;
  const scripts = Object.entries(lock.packages ?? {}).filter(([k, v]) => k && v.hasInstallScript).map(([k]) => k.replace(/^.*node_modules\//, ''));
  if (problems.length) {
    console.error(`lint:lock: ${problems.length} problem(s) in package-lock.json:\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`lint:lock: ${count} packages, all from ${REGISTRY} over HTTPS with sha512 integrity and matching names; package.json pins exact versions.`);
    if (scripts.length) console.log(`  packages with install scripts (never run: install with npm ci --ignore-scripts): ${[...new Set(scripts)].join(', ')}`);
  }
}
