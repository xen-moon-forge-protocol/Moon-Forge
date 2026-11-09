// The chains the bot may burn on: every portal in deployments/portals.json, cross-checked against the portal list
// built into the kit. A chain added to portals.json (OPERATORS.md, "Add a chain") appears here on the next start; it
// becomes burnable once the kit you run knows its portal too (the kit's quote refuses any other chain) and once you give
// it an RPC in the config. An address that differs from the kit's is refused: a config file is never trusted over code.
import fs from 'node:fs';
import { KIT_PORTALS } from './kit.mjs';
import { chainSettings } from './config.mjs';

const lower = (s) => String(s ?? '').toLowerCase();

/** Reads deployments/portals.json; returns [{ chain, chainId, address, xen }]. Throws on a file that is not the expected shape. */
export function readPortalsFile(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(j?.portals)) throw new Error('portals file: no "portals" list');
  return j.portals.map((p) => ({ chain: String(p.chain), chainId: Number(p.chainId), address: String(p.address), xen: String(p.xen) }));
}

/**
 * Joins the published portals with the kit's list and the owner's chain settings. Each entry carries `usable` and,
 * when false, `why` (printed on every tick, so a skipped chain is never silent).
 */
export function resolveChains(cfg, published, kitPortals = KIT_PORTALS) {
  return published.map((p) => {
    const s = chainSettings(cfg, p.chainId);
    const kit = kitPortals.find((k) => k.chainId === p.chainId);
    const base = { name: p.chain, chainId: p.chainId, portal: p.address, xen: p.xen, settings: s };
    if (!kit) return { ...base, usable: false, why: 'the kit in use has no portal for this chain yet: update the kit to a reviewed version that lists it' };
    if (lower(kit.portal) !== lower(p.address) || lower(kit.xen) !== lower(p.xen)) return { ...base, usable: false, why: 'the portal or XEN address in portals.json differs from the kit: refused (check both against the explorer)' };
    if (s.enabled === false) return { ...base, usable: false, why: 'disabled in the config' };
    if (!s.rpcs?.length) return { ...base, usable: false, why: `no RPC in burn.chains["${p.chainId}"].rpcs` };
    return { ...base, usable: true, why: null };
  });
}
