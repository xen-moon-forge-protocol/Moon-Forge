/**
 * Legacy Pilot (owner request 2026-11-02, item 19): a one-time recognition for the EVM addresses that burned XEN
 * before 2026-11-01 00:00:00 UTC, as recorded by XEN's own contracts. Off-chain only (no program change), paid ONLY
 * from what the normal rules leave unpaid, so it never lowers what anyone else receives in the epoch that pays it.
 *
 *  Eligibility: an EVM address with a Transfer(from = address, to = 0x0) of XEN, emitted by the XEN token contract of
 *    one of the source chains (the five Moon Forge chains plus Ethereum: an EVM address is the same on every chain),
 *    in a block whose timestamp is before LEGACY_CUTOFF_TS. The list is a public, reproducible snapshot
 *    (deployments/legacy-burners.json, built on GitHub by .github/workflows/legacy-snapshot.yml with
 *    scripts/legacy/build-snapshot.mjs); its sha256 (legacySnapshotSha256) is written into the hashed rules block of
 *    every base epoch (rulesBlock.legacyPilot), so any change to the list or the rule is visible and verify reproduces it.
 *  Benefit 1 (the burn, rewards.ts): the first Moon Forge burn of a listed address, in mission order (the arrival order
 *    of the base epoch), receives a one-time top-up of burnTopUpBps (50%) of that burn's base payout (alloc), paid only
 *    from the capacity every normal claim of the week left (capacity.left, which would otherwise stay in the pool),
 *    capped at leftoverBps (25%) of it, and served in mission order when the cap is short: the earlier candidates whole,
 *    one partial, the rest 0. The top-ups are the week's LAST claims (after the operator burns too), on the burner's
 *    Launchpad (tier-0) leaf, through the same build limit, so a shortfall cuts them first. An address is "used" once a
 *    top-up of more than 0 was paid to it; the used set is carried from file to file (legacy.used), so verify reproduces
 *    it from the previous file. A burn that receives 0 (no leftover that week) does not use the address.
 *  Benefit 2 (an Artifact, extra.ts): the first Artifact forged by an X1 wallet linked to a listed address (the wallet
 *    named as x1 in a burn of that address in a base epoch under the rule) receives a one-time rebate of
 *    artifactRebateBps (20%) of its forge price, paid only from the extra pot's weekly release left after the normal
 *    holder rebates, within every bound of the extra pot (8% of the pot and 4% of the live forged backing a week). The
 *    claim is established once, in the extra epoch of the Artifact's first snapshot, and uses the wallet and the address;
 *    what a week's room cannot pay stays owed and is paid from the next weeks' room, oldest claim first, until whole.
 *    Once per X1 wallet and once per listed address.
 *
 * Nothing here is read by the normal rules: a burn's base payout, the capacity, every normal leaf and every holder's
 * extra rebate are exactly what they are without the rule (LEGACY-1 / LEGACY-2, test/legacy.test.ts, the fairness and
 * 104-week suites).
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

// ── the rule (pinned: a change is a new rules version) ───────────────────────────────────────────────
/** 2026-11-01T00:00:00Z: a burn of XEN in a block stamped before this instant makes its address eligible */
export const LEGACY_CUTOFF_TS = 1_793_491_200;
/**
 * The XEN token contracts the snapshot scans, by chain id: Ethereum plus the five Moon Forge chains (config.ts `xen`).
 * Lowercase. BSC and Polygon share one address.
 */
export const LEGACY_SOURCES: readonly { chainId: number; xen: string }[] = Object.freeze([
  { chainId: 1, xen: "0x06450dee7fd2fb8e39061434babcfc05599a6fb8" },
  { chainId: 10, xen: "0xeb585163debb1e637c6d617de3bef99347cd75c8" },
  { chainId: 56, xen: "0x2ab0e9e4ee70fff1fb9d67031e44f6410170d00e" },
  { chainId: 137, xen: "0x2ab0e9e4ee70fff1fb9d67031e44f6410170d00e" },
  { chainId: 8453, xen: "0xffcbf84650ce02dafe96926b37a0ac5e34932fa5" },
  { chainId: 43114, xen: "0xc0c5aa69dbe4d6dddfbc89c0957686ec60f24389" },
]);
/** benefit 1: +50% of the burn's base payout (1.5× in total) */
export const LEGACY_BURN_TOPUP_BPS = 5_000n;
/** benefit 1: the week's top-ups together take at most 25% of the capacity every normal claim left */
export const LEGACY_LEFTOVER_BPS = 2_500n;
/** benefit 1: when the cap is short, the top-ups are served in mission order (whole, one partial, then 0) */
export const LEGACY_ORDER = "mission-order" as const;
/** benefit 2: 20% of the Artifact's forge price (paid over as many weeks as the leftover release needs) */
export const LEGACY_ARTIFACT_REBATE_BPS = 2_000n;
const BPS = 10_000n;

/**
 * The sha256 of deployments/legacy-burners.json (legacySnapshotSha256), pinned once the snapshot workflow has built it.
 * null = not pinned: the rule is not armed and no file carries it. Pinning it arms the rule in the rules of the first v3
 * epoch (rules-v3.ts); pin it BEFORE the first v3 epoch is built. After that, the rule can only come in as a new rules
 * version (rulesId + 1, with its fromEpoch and announcement), never by editing a version files were built under.
 */
export const LEGACY_SNAPSHOT_SHA256: string | null = null;
/** where the oracle reads the snapshot (the repository copy, committed with its pin) */
export const LEGACY_SNAPSHOT_FILE = path.join(__dirname, "..", "..", "deployments", "legacy-burners.json");

/** The Legacy Pilot member of the rules block (rewards.ts RulesBlockV3.legacyPilot), hashed with every file built under it. */
export interface LegacyPilotRulesV3 {
  /** eligibility: a burn of XEN stamped before this instant (unix seconds) */
  cutoffTs: number;
  /** the chains whose XEN contract the snapshot scans (ascending) */
  sourceChains: number[];
  /** sha256 of the snapshot (legacySnapshotSha256 of deployments/legacy-burners.json) */
  snapshotSha256: string;
  /** benefit 1: the top-up, in bps of the burn's base payout */
  burnTopUpBps: number;
  /** benefit 1: the week's cap, in bps of the capacity every normal claim left */
  leftoverBps: number;
  /** benefit 1: how a short cap is shared */
  order: typeof LEGACY_ORDER;
  /** benefit 2: the rebate, in bps of the Artifact's forge price */
  artifactRebateBps: number;
}

const LEGACY_RULE_KEYS = ["artifactRebateBps", "burnTopUpBps", "cutoffTs", "leftoverBps", "order", "snapshotSha256", "sourceChains"];

/** The rule of this engine with snapshot `sha256`. */
export function legacyPilotRules(sha256: string): LegacyPilotRulesV3 {
  return {
    cutoffTs: LEGACY_CUTOFF_TS, sourceChains: LEGACY_SOURCES.map((s) => s.chainId), snapshotSha256: sha256, burnTopUpBps: Number(LEGACY_BURN_TOPUP_BPS),
    leftoverBps: Number(LEGACY_LEFTOVER_BPS), order: LEGACY_ORDER, artifactRebateBps: Number(LEGACY_ARTIFACT_REBATE_BPS),
  };
}

/**
 * rules-v3.ts: what the rules of the first v3 epoch add for the Legacy Pilot: the member once the snapshot is pinned
 * (LEGACY_SNAPSHOT_SHA256), nothing before (the rule is not armed and files are exactly those without it).
 */
export function legacyRulesPatch(sha256: string | null = LEGACY_SNAPSHOT_SHA256): { legacyPilot?: LegacyPilotRulesV3 } {
  return sha256 === null ? {} : { legacyPilot: legacyPilotRules(sha256) };
}

/** The Legacy Pilot member as the engine uses it, or a throw: every parameter is this engine's, the sha256 a lowercase hex. */
export function legacyPilotRulesOf(v: unknown): LegacyPilotRulesV3 {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("rulesBlock.legacyPilot is not an object");
  const have = Object.keys(v).sort();
  if (have.join(",") !== LEGACY_RULE_KEYS.join(",")) throw new Error(`rulesBlock.legacyPilot must have exactly the members ${LEGACY_RULE_KEYS.join(", ")} (has ${have.join(", ")})`);
  const o = v as Record<string, unknown>;
  if (typeof o.snapshotSha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.snapshotSha256)) throw new Error(`rulesBlock.legacyPilot.snapshotSha256 ${JSON.stringify(o.snapshotSha256)} is not a lowercase sha256 hex`);
  const want = legacyPilotRules(o.snapshotSha256);
  if (JSON.stringify(sortKeys(o)) !== JSON.stringify(sortKeys(want))) {
    throw new Error(`rulesBlock.legacyPilot ${JSON.stringify(sortKeys(o)).slice(0, 300)} is not this engine's rule ${JSON.stringify(sortKeys({ ...want, snapshotSha256: "<sha256>" }))}`);
  }
  return want;
}

// ── addresses ─────────────────────────────────────────────────────────────────────────────────────
/** An EVM address as the snapshot and the files record it: lowercase 0x + 40 hex (a checksummed input is lowered). */
export function evmAddressOf(v: unknown, what: string): string {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${what}: ${JSON.stringify(v)} is not an EVM address`);
  return v.toLowerCase();
}

/** A recorded address list: lowercase EVM addresses, strictly ascending (no duplicate). */
export function addressListOf(v: unknown, what: string): string[] {
  if (!Array.isArray(v)) throw new Error(`${what} is not an array`);
  const out = v.map((a, i) => {
    if (typeof a !== "string" || !/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`${what}[${i}]: ${JSON.stringify(a)} is not a lowercase EVM address`);
    return a;
  });
  for (let i = 1; i < out.length; i++) if (!(out[i - 1] < out[i])) throw new Error(`${what} must be strictly ascending: ${out[i - 1]} before ${out[i]}`);
  return out;
}

// ── the snapshot (deployments/legacy-burners.json) ────────────────────────────────────────────────
export interface LegacySnapshotChain {
  chainId: number;
  /** the XEN token contract scanned (lowercase) */
  xen: string;
  /** the first block scanned (at or before XEN's deployment on that chain) */
  fromBlock: number;
  /** the cutoff block: the last block stamped before the cutoff */
  toBlock: number;
  /** burn events counted (Transfer to 0x0 with a value above 0) */
  events: number;
  /** distinct burning addresses on this chain */
  addresses: number;
}

export interface LegacySnapshotDoc {
  /** the cutoff instant (unix seconds) */
  cutoff: number;
  /** by chain id, ascending */
  chains: LegacySnapshotChain[];
  /** every eligible address: lowercase, strictly ascending, unique across the chains */
  addresses: string[];
  /** legacySnapshotSha256 of the members above */
  sha256: string;
}

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;

/**
 * sha256 (hex) of the snapshot's canonical JSON: { addresses, chains, cutoff } with every object's keys sorted and no
 * whitespace. scripts/legacy/build-snapshot.mjs computes the same bytes (test/legacy.test.ts runs both).
 */
export function legacySnapshotSha256(doc: { cutoff: number; chains: LegacySnapshotChain[]; addresses: string[] }): string {
  return createHash("sha256").update(JSON.stringify(sortKeys({ addresses: doc.addresses, chains: doc.chains, cutoff: doc.cutoff }))).digest("hex");
}

/**
 * null when `doc` is a snapshot of this rule (the cutoff, the source chains and their XEN contracts, sorted unique
 * lowercase addresses, consistent counts, its own sha256), else why not.
 */
export function legacySnapshotError(doc: unknown, sources: readonly { chainId: number; xen: string }[] = LEGACY_SOURCES, cutoff = LEGACY_CUTOFF_TS): string | null {
  try {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "the snapshot is not an object";
    const o = doc as Record<string, unknown>;
    const keys = Object.keys(o).sort().join(",");
    if (keys !== "addresses,chains,cutoff,sha256") return `the snapshot must have exactly the members addresses, chains, cutoff, sha256 (has ${keys})`;
    if (o.cutoff !== cutoff) return `the snapshot's cutoff ${JSON.stringify(o.cutoff)} is not the rule's ${cutoff}`;
    if (!Array.isArray(o.chains) || o.chains.length !== sources.length) return `the snapshot must list the ${sources.length} source chains`;
    const addresses = addressListOf(o.addresses, "snapshot addresses");
    for (const [i, c] of (o.chains as Record<string, unknown>[]).entries()) {
      const s = sources[i];
      if (!c || typeof c !== "object" || Object.keys(c).sort().join(",") !== "addresses,chainId,events,fromBlock,toBlock,xen") return `snapshot chains[${i}] must have exactly addresses, chainId, events, fromBlock, toBlock, xen`;
      if (c.chainId !== s.chainId || c.xen !== s.xen) return `snapshot chains[${i}] is ${String(c.chainId)} ${String(c.xen)}, expected ${s.chainId} ${s.xen}`;
      for (const k of ["fromBlock", "toBlock", "events", "addresses"]) if (!Number.isSafeInteger(c[k]) || (c[k] as number) < 0) return `snapshot chain ${s.chainId}: ${k} is not a non-negative integer`;
      if ((c.fromBlock as number) > (c.toBlock as number)) return `snapshot chain ${s.chainId}: fromBlock after toBlock`;
      if ((c.addresses as number) > (c.events as number) || (c.addresses as number) > addresses.length) return `snapshot chain ${s.chainId}: more addresses than events or than the list`;
    }
    const sha = legacySnapshotSha256({ cutoff: o.cutoff as number, chains: o.chains as LegacySnapshotChain[], addresses });
    if (o.sha256 !== sha) return `the snapshot's sha256 ${JSON.stringify(o.sha256)} is not its content's ${sha}`;
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** A loaded snapshot: its sha256 and a membership test. */
export interface LegacySnapshotSet {
  sha256: string;
  size: number;
  has(address: string): boolean;
}

/** A snapshot document as a set (checked with legacySnapshotError first; throws on a bad one). */
export function legacySnapshotSetOf(doc: unknown): LegacySnapshotSet {
  const bad = legacySnapshotError(doc);
  if (bad) throw new Error(bad);
  const d = doc as LegacySnapshotDoc;
  const set = new Set(d.addresses);
  return { sha256: d.sha256, size: set.size, has: (a: string) => set.has(a.toLowerCase()) };
}

let cached: { file: string; mtimeMs: number; set: LegacySnapshotSet } | null = null;
/** Reads and checks the repository snapshot (cached while the file is unchanged); throws when missing or malformed. */
export function loadLegacySnapshot(file = LEGACY_SNAPSHOT_FILE): LegacySnapshotSet {
  const st = fs.statSync(file);
  if (cached && cached.file === file && cached.mtimeMs === st.mtimeMs) return cached.set;
  const set = legacySnapshotSetOf(JSON.parse(fs.readFileSync(file, "utf8")));
  cached = { file, mtimeMs: st.mtimeMs, set };
  return set;
}

// ── the listing a build records (rewards.ts EpochInputsV3.legacyPilot) ───────────────────────────────
/**
 * The window's burn pilots that the snapshot lists, as the build records them (hashed with the file). `unavailable`:
 * the snapshot could not be read or is not the pinned one; then nobody is listed that week (nobody's eligibility is
 * used up either: an address is used only by a top-up actually paid) and the reason is recorded, so a missing file never
 * stops an epoch (the pattern of the Artifact snapshot, A13.9).
 */
export interface LegacyListingV3 {
  snapshotSha256: string;
  /** lowercase EVM addresses, strictly ascending: every one is the pilot of a burn of the window */
  listed: string[];
  unavailable?: { reason: string };
}

const reasonOf = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 500) : "") || "unknown";

/** The listing of `pilots` (any case) against `snapshot` for `rule`; a snapshot that failed to load gives the unavailable listing. */
export function legacyListingOf(rule: LegacyPilotRulesV3, pilots: string[], snapshot: LegacySnapshotSet | Error): LegacyListingV3 {
  if (snapshot instanceof Error) return { snapshotSha256: rule.snapshotSha256, listed: [], unavailable: { reason: reasonOf(`the Legacy Pilot snapshot could not be read: ${snapshot.message}`) } };
  if (snapshot.sha256 !== rule.snapshotSha256) {
    return { snapshotSha256: rule.snapshotSha256, listed: [], unavailable: { reason: reasonOf(`the Legacy Pilot snapshot read has sha256 ${snapshot.sha256}, not the rule's ${rule.snapshotSha256}`) } };
  }
  const listed = [...new Set(pilots.map((p) => evmAddressOf(p, "burn pilot")))].filter((p) => snapshot.has(p)).sort();
  return { snapshotSha256: rule.snapshotSha256, listed };
}

/**
 * The build's hook (flow-v3.ts): the `legacyPilot` input of a build under `rulesBlock` with these chains' burns: {} when
 * the rule is not in the block, else the listing against the repository snapshot (never a throw: a snapshot that cannot be
 * read gives the unavailable listing).
 */
export function legacyPilotInputsV3(
  rulesBlock: { legacyPilot?: LegacyPilotRulesV3 } | undefined, chains: { burns: { pilot: string }[] }[], load: () => LegacySnapshotSet = () => loadLegacySnapshot(),
): { legacyPilot?: LegacyListingV3 } {
  const rule = rulesBlock?.legacyPilot;
  if (!rule) return {};
  let snapshot: LegacySnapshotSet | Error;
  try {
    snapshot = load();
  } catch (e) {
    snapshot = e instanceof Error ? e : new Error(String(e));
  }
  return { legacyPilot: legacyListingOf(rule, chains.flatMap((c) => c.burns.map((b) => b.pilot)), snapshot) };
}

/**
 * `verify --full` with the snapshot document: null-free list of problems (empty = OK). The file's rule names the
 * document's sha256, and its listing is exactly the window's burn pilots the document lists (or recorded unavailable).
 */
export function verifyLegacyListingV3(
  f: { epoch: number; rulesBlock?: { legacyPilot?: unknown }; burns: { pilot: string }[]; legacy?: { listing: LegacyListingV3 } },
  doc: unknown,
): string[] {
  const rule = f.rulesBlock?.legacyPilot;
  if (rule === undefined) return f.legacy === undefined ? [] : [`epoch ${f.epoch} records a Legacy Pilot section without the rule`];
  const out: string[] = [];
  let set: LegacySnapshotSet;
  try {
    set = legacySnapshotSetOf(doc);
  } catch (e) {
    return [`the Legacy Pilot snapshot given is not valid: ${(e as Error).message}`];
  }
  const r = legacyPilotRulesOf(rule);
  if (set.sha256 !== r.snapshotSha256) out.push(`epoch ${f.epoch}: the rule names snapshot ${r.snapshotSha256}, the document given is ${set.sha256}`);
  const listing = f.legacy?.listing;
  if (!listing) return [...out, `epoch ${f.epoch}: the rule is in force but the file records no listing`];
  if (listing.unavailable) {
    if (listing.listed.length) out.push(`epoch ${f.epoch}: an unavailable listing lists addresses`);
    return out;
  }
  const want = legacyListingOf(r, f.burns.map((b) => b.pilot), set);
  if (JSON.stringify(want.listed) !== JSON.stringify(listing.listed)) {
    const extra = listing.listed.filter((a) => !want.listed.includes(a));
    const missing = want.listed.filter((a) => !listing.listed.includes(a));
    out.push(`epoch ${f.epoch}: the listing differs from the snapshot (listed but not in it: ${extra.slice(0, 5).join(", ") || "none"}; in it but not listed: ${missing.slice(0, 5).join(", ") || "none"})`);
  }
  return out;
}

/**
 * `verify --full` (index.ts): the file's listing against the snapshot file (the repository's by default). A file without
 * the rule: nothing to check. A missing snapshot is reported as unreadable (the run is INCOMPLETE, never a pass), with
 * where to get it; a snapshot that is not JSON, or a listing that differs, is an error.
 */
export function legacyListingCheckV3(
  f: { epoch: number; rulesBlock?: { legacyPilot?: unknown }; burns: { pilot: string }[]; legacy?: { listing: LegacyListingV3 } },
  file = LEGACY_SNAPSHOT_FILE,
): { errors: string[]; unreadable: string[] } {
  if (f.rulesBlock?.legacyPilot === undefined) return { errors: [], unreadable: [] };
  if (!fs.existsSync(file)) {
    return {
      errors: [],
      unreadable: [`the Legacy Pilot snapshot deployments/legacy-burners.json is missing (it is in the repository, and an artifact of the legacy-snapshot workflow): the listing of epoch ${f.epoch} is unconfirmed`],
    };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { errors: [`the Legacy Pilot snapshot deployments/legacy-burners.json is not valid JSON: ${(e as Error).message.slice(0, 200)}`], unreadable: [] };
  }
  return { errors: verifyLegacyListingV3(f, doc), unreadable: [] };
}

/** ⌊amount × bps / 10^4⌋ */
export const bpsOf = (amount: bigint, bps: bigint | number): bigint => (amount * BigInt(bps)) / BPS;
