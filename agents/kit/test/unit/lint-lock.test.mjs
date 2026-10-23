// node --test: the dependency-free lockfile check (test/lint-lock.mjs) passes on the committed lockfile and catches
// every kind of entry it must refuse. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintLock } from '../lint-lock.mjs';

const kit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lock = JSON.parse(fs.readFileSync(path.join(kit, 'package-lock.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(kit, 'package.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(lock));

test('the committed lockfile and package.json pass: every package pinned to the registry with a sha512 hash', () => {
  assert.deepEqual(lintLock(lock, pkg), []);
  assert.ok(Object.keys(lock.packages).length > 50);
});

test('refused: missing integrity, sha1 integrity, missing resolved, http, another host, a name/URL mismatch, a link', () => {
  const key = 'node_modules/bs58';
  const cases = [
    [(e) => { delete e.integrity; }, /no integrity hash/],
    [(e) => { e.integrity = 'sha1-2jmFMWBNfJ6Rkkk5lcvZ7MO1Ra8='; }, /not a sha512 hash/],
    [(e) => { delete e.resolved; }, /no "resolved" URL/],
    [(e) => { e.resolved = e.resolved.replace('https:', 'http:'); }, /not HTTPS/],
    [(e) => { e.resolved = e.resolved.replace('registry.npmjs.org', 'registry.evil.example'); }, /is not the npm registry/],
    [(e) => { e.resolved = 'https://registry.npmjs.org/bs58-evil/-/bs58-evil-6.0.0.tgz'; }, /does not match its name and version/],
    [(e) => { e.link = true; }, /linked/],
  ];
  for (const [mutate, expected] of cases) {
    const l = clone();
    mutate(l.packages[key]);
    const problems = lintLock(l, pkg);
    assert.equal(problems.length, 1, problems.join('; '));
    assert.match(problems[0], expected);
  }
});

test('refused: a range, a tag or a URL in package.json dependencies or overrides; a pre-npm-7 lockfile', () => {
  for (const spec of ['^1.98.4', '~0.32.1', 'latest', 'github:x/y', '*', '1.x']) {
    assert.match(lintLock(lock, { ...pkg, dependencies: { ...pkg.dependencies, bs58: spec } }).join(), /not an exact version/, spec);
  }
  assert.match(lintLock(lock, { ...pkg, overrides: { uuid: '>=11' } }).join(), /overrides\.uuid/);
  assert.match(lintLock({ ...lock, lockfileVersion: 1 }, pkg).join(), /lockfileVersion 1/);
});
