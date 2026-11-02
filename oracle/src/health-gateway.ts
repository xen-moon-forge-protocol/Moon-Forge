/**
 * the data side of the "nft metadata gateway" health row (the rule is health-rules.ts gatewayVerdict).
 *
 * Which set: before the S2 build METADATA_BASE_URI in programs/moon-forge/src/constants.rs still holds the Arweave
 * placeholder, so every set of deployments/nft-arweave-final.json is checked (the build compiles one of them). After the
 * build the compiled URI names one metadata manifest: only that set is checked, through the compiled host first.
 * What: collection.json, the first metadata file of each tier and the first image of each tier (9 paths), each through
 * the set's gateway and one alternative (the record's other gateway, else arweave.net), each body against the sha256
 * the record holds. Read-only HTTP GETs of public Arweave paths; no key, nothing else.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { GatewayProbe, GatewaySetRun } from "./health-rules";

export const PLACEHOLDER = "ARWEAVE_MANIFEST_ID_TBD";
export const FALLBACK_GATEWAY = "arweave.net";
export const TIERS = ["lunar_dust", "cosmic_shard", "solar_core", "void_anomaly"];
const ID = /^[A-Za-z0-9_-]{43}$/;

export interface ArweaveFile { id?: string; bytes?: number; sha256: string }
export interface ArweaveSet { gateway: string; imageBaseUri: string; manifest: string; metadataBaseUri: string; files: Record<string, ArweaveFile> }
export interface ArweaveRecord { kind: string; version: number; images: { manifest: string; files: Record<string, ArweaveFile> }; sets: ArweaveSet[] }

/** One path to load: the manifest it is read through, its path in that manifest, and the recorded sha256. */
export interface GatewayItem { manifest: string; path: string; sha256: string }
export interface GatewayTarget { manifest: string; label: string; gateways: string[]; items: GatewayItem[] }

/** METADATA_BASE_URI from constants.rs (null: not found, or still the placeholder: the build has not happened). */
export function compiledMetadataUri(constantsRs: string): string | null {
  const m = /pub const METADATA_BASE_URI: &str = "([^"]*)";/.exec(constantsRs);
  if (!m || m[1].includes(PLACEHOLDER)) return null;
  return m[1];
}

/** host and manifest id of a base URI "https://<host>/<manifest>/" (null when it is not one) */
export function parseBaseUri(uri: string): { host: string; manifest: string } | null {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  const seg = u.pathname.split("/").filter(Boolean);
  if (u.protocol !== "https:" || seg.length !== 1 || !ID.test(seg[0])) return null;
  return { host: u.host, manifest: seg[0] };
}

/** a record as written by the upload workflow (kind moon-forge-nft-arweave, version 2), checked; throws otherwise */
export function recordOf(v: unknown): ArweaveRecord {
  const r = v as ArweaveRecord;
  if (!r || r.kind !== "moon-forge-nft-arweave" || r.version !== 2) throw new Error("not a moon-forge-nft-arweave version 2 record");
  if (!r.images || !ID.test(r.images.manifest) || !r.images.files) throw new Error("the record has no images manifest");
  if (!Array.isArray(r.sets) || !r.sets.length) throw new Error("the record has no metadata set");
  for (const s of r.sets) {
    if (!ID.test(s.manifest) || !s.files || !s.files["collection.json"]) throw new Error(`set ${String(s.gateway)}: no manifest or no collection.json`);
    const b = parseBaseUri(s.metadataBaseUri);
    if (!b || b.manifest !== s.manifest) throw new Error(`set ${s.gateway}: metadataBaseUri does not name its manifest`);
  }
  return r;
}

const firstOf = (files: Record<string, ArweaveFile>, dir: string, ext: RegExp) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`) && ext.test(p)).sort()[0];

/** the 9 paths of one set: collection.json, then per tier its first metadata file and its first image */
export function itemsOf(rec: ArweaveRecord, set: ArweaveSet): GatewayItem[] {
  const items: GatewayItem[] = [{ manifest: set.manifest, path: "collection.json", sha256: set.files["collection.json"].sha256 }];
  for (const t of TIERS) {
    const j = firstOf(set.files, t, /\.json$/);
    if (j) items.push({ manifest: set.manifest, path: j, sha256: set.files[j].sha256 });
    const im = firstOf(rec.images.files, t, /\.(webp|png|jpe?g|gif)$/);
    if (im) items.push({ manifest: rec.images.manifest, path: im, sha256: rec.images.files[im].sha256 });
  }
  return items;
}

/**
 * The sets to check (pure; tested). compiled = METADATA_BASE_URI once it is final, else null. Returns the phase, the
 * targets and a configuration problem (a compiled URI that is in no set of the record).
 */
export function gatewayTargets(rec: ArweaveRecord, compiled: string | null): { phase: "candidates" | "compiled"; targets: GatewayTarget[]; problem: string | null } {
  const hosts = [...new Set(rec.sets.map((s) => new URL(s.metadataBaseUri).host))];
  const alt = (primary: string) => hosts.find((h) => h !== primary) ?? (primary === FALLBACK_GATEWAY ? hosts[0] ?? FALLBACK_GATEWAY : FALLBACK_GATEWAY);
  const target = (set: ArweaveSet, primary: string, label: string): GatewayTarget => {
    const a = alt(primary);
    return { manifest: set.manifest, label, gateways: a === primary ? [primary] : [primary, a], items: itemsOf(rec, set) };
  };
  if (compiled === null) return { phase: "candidates", targets: rec.sets.map((s) => target(s, new URL(s.metadataBaseUri).host, `set ${s.gateway}`)), problem: null };
  const c = parseBaseUri(compiled);
  const set = c ? rec.sets.find((s) => s.manifest === c.manifest) : undefined;
  if (!c || !set) return { phase: "compiled", targets: [], problem: `METADATA_BASE_URI ${compiled} is not a metadata set of deployments/nft-arweave-final.json` };
  return { phase: "compiled", targets: [target(set, c.host, `compiled set ${c.host}/${c.manifest.slice(0, 8)}…`)], problem: null };
}

export type Fetcher = (url: string) => Promise<Uint8Array>;
/** GET with a time limit; a non-200 answer throws */
export const httpFetcher = (ms = 30_000): Fetcher => async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

/** Loads every item of a target through each of its gateways and compares the sha256 (never throws). */
export async function probeTarget(t: GatewayTarget, fetcher: Fetcher, concurrency = 6): Promise<GatewaySetRun> {
  const jobs = t.items.flatMap((it) => t.gateways.map((g) => ({ it, g })));
  const probes: GatewayProbe[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const k = next++;
      if (k >= jobs.length) return;
      const { it, g } = jobs[k];
      try {
        const body = await fetcher(`https://${g}/${it.manifest}/${it.path}`);
        const h = createHash("sha256").update(body).digest("hex");
        probes[k] = h === it.sha256 ? { path: it.path, gateway: g, ok: true } : { path: it.path, gateway: g, ok: false, why: `sha256 ${h.slice(0, 12)}…, recorded ${it.sha256.slice(0, 12)}…` };
      } catch (e) {
        probes[k] = { path: it.path, gateway: g, ok: false, why: String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 80) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return { manifest: t.manifest, label: t.label, gateways: t.gateways, probes };
}

/** The record and the constants of this checkout (paths relative to oracle/, the health job's working directory). */
export function readGatewayInputs(): { rec: ArweaveRecord | null; compiled: string | null; problem: string | null } {
  const recPath = process.env.NFT_RECORD || path.join("..", "deployments", "nft-arweave-final.json");
  const constPath = process.env.METADATA_CONSTANTS || path.join("..", "programs", "moon-forge", "src", "constants.rs");
  let rec: ArweaveRecord | null = null;
  try {
    rec = recordOf(JSON.parse(fs.readFileSync(recPath, "utf8")));
  } catch (e) {
    return { rec: null, compiled: null, problem: `deployments/nft-arweave-final.json unreadable: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
  }
  let compiled: string | null = null;
  try {
    compiled = compiledMetadataUri(fs.readFileSync(constPath, "utf8"));
  } catch {
    compiled = null; // no program source in this checkout: treated as before the build (every set is checked)
  }
  return { rec, compiled, problem: null };
}
