/**
 * Runtime rules detection: everything new on this site is switched on by what X1 and the published epoch files say,
 * never by a merge or a build flag, so the code can ship before each event and turns on by itself.
 *
 *  - rules (the program): 3 once the account only the upgraded program creates, ExtraState ["extra_state"]
 *    (FF4CHxw1XgCMYv9Q48yB8qX4W19oDcGK2wrqZhEEvYrE, created by init_extra at the upgrade), exists, is owned by the
 *    Moon Forge program and decodes (discriminator + size, src/v3/layout.ts); 2 while it does not exist; 'unknown'
 *    when X1 cannot be read or the account exists but does not decode.
 *  - rewards (the oracle): 3 once the NEWEST epoch listed in epochs/index.json is a version-3 file (oracle/src/rewards.ts
 *    EpochBodyV3: version 3 with a window and a capacity block), OR once the announced boundary transaction
 *    (src/v3/facts-v3.ts V3_BOUNDARY.lastV2PublishTx) is the newest entry of the index: the v3 window starts at that
 *    publication, so every burn after it is scored under v3 a full week before the first version-3 file exists
 *    (X-034, T9-25). 2 for a version-2 file (epoch-1.json) or no epoch yet; 'unknown' when the index or the file cannot
 *    be read or does not parse, or when a version-2 file is newer than the announced boundary (constant and files
 *    disagree).
 *
 * Fail-closed: anything but a positive 3 behaves exactly like the live release (rules 2, rewards 2). A v3 number or text
 * is never shown on 'unknown'.
 *
 * Manual override for previews (never on the public site): on localhost, or in a build made with
 * VITE_MF_DETECT_OVERRIDE=1, `?mf_rules=2|3&mf_rewards=2|3` (remembered in sessionStorage for the tab; `?mf_detect=clear`
 * forgets it) forces the answer, and a banner says so on every page.
 */
import { useSyncExternalStore } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { PROGRAM_ID_B58 } from '../lib/constants';
import { decodeExtraState, type ExtraStateView } from './layout';
import { V3_BOUNDARY } from './facts-v3';

export type Version = 2 | 3;
export type Detected = Version | 'unknown';

export interface Override { rules?: Version; rewards?: Version }

export interface DetectionState {
    /** program rules: 3 = upgraded program (ExtraState exists and decodes) */
    rules: Detected;
    /** oracle rewards rules of the newest published epoch file */
    rewards: Detected;
    /** true until both reads answered once (the site behaves as rules 2 / rewards 2 meanwhile) */
    pending: boolean;
    /** the override in force (previews only), or null */
    override: Override | null;
    /** the decoded ExtraState when rules = 3 from the chain (null under an override or before the upgrade) */
    extraState: ExtraStateView | null;
    /** newest epoch number in epochs/index.json and its file version */
    newestEpoch: number | null;
    newestVersion: number | null;
    /** true once epochs/index.json lists the announced boundary transaction (V3_BOUNDARY.lastV2PublishTx) */
    boundaryPassed: boolean;
    rulesCheckedAt: number | null;
    rewardsCheckedAt: number | null;
    rulesError: string | null;
    rewardsError: string | null;
}

export const PROGRAM_PK = new PublicKey(PROGRAM_ID_B58);
export const EXTRA_STATE_PDA = PublicKey.findProgramAddressSync([new TextEncoder().encode('extra_state')], PROGRAM_PK)[0];
export const X1_RPC_DETECT = 'https://rpc.mainnet.x1.xyz';

// ── pure decisions (unit-tested in test/v3/detect.test.ts) ───────────────────────────────────────────────────
export interface AccountLike { owner: PublicKey | string; data: Uint8Array }

/**
 * `info` undefined = the read failed; null = the account does not exist.
 * Not owned by the program (for example lamports someone sent to the address, a System account with no data) = not
 * created by the upgraded program: rules 2. Owned by the program but not an ExtraState = unexpected: 'unknown'.
 */
export function rulesFromAccount(info: AccountLike | null | undefined, programId: PublicKey | string = PROGRAM_PK): { rules: Detected; extraState: ExtraStateView | null } {
    if (info === undefined) return { rules: 'unknown', extraState: null };
    if (info === null) return { rules: 2, extraState: null };
    if (info.owner.toString() !== programId.toString()) return { rules: 2, extraState: null };
    const x = decodeExtraState(info.data);
    return x ? { rules: 3, extraState: x } : { rules: 'unknown', extraState: null };
}

export interface IndexLike { epochs?: { epoch: number; version?: unknown; tx?: unknown }[] }

/** The newest epoch entry of epochs/index.json, or null when none is listed. Throws on a malformed index. */
export function newestEntry(index: IndexLike): { epoch: number; version?: unknown } | null {
    if (!index || !Array.isArray(index.epochs)) throw new Error('epochs/index.json has no epochs array');
    let best: { epoch: number; version?: unknown } | null = null;
    for (const e of index.epochs) {
        if (!e || !Number.isSafeInteger(e.epoch) || e.epoch < 1) throw new Error('epochs/index.json lists a bad epoch number');
        if (!best || e.epoch > best.epoch) best = e;
    }
    return best;
}

/**
 * The rules version of an epoch file: 3 only for a version-3 body with its window and capacity (rewards.ts EpochBodyV3),
 * 2 for a version-2 file. Anything else is 'unknown' (fail-closed: shown as the live release).
 */
export function versionOfEpochFile(f: unknown): Detected {
    if (!f || typeof f !== 'object') return 'unknown';
    const o = f as Record<string, any>;
    if (o.version === 3) {
        const w = o.window;
        const okWindow = w && Number.isSafeInteger(w.startTs) && Number.isSafeInteger(w.endTs) && w.endTs > w.startTs;
        const okCap = o.capacity && typeof o.capacity.cash === 'string' && /^(0|[1-9][0-9]*)$/.test(o.capacity.cash);
        return okWindow && okCap && Array.isArray(o.leaves) && typeof o.root === 'string' ? 3 : 'unknown';
    }
    if (o.version === 2 || o.version === undefined) return Array.isArray(o.leaves) && typeof o.root === 'string' ? 2 : 'unknown';
    return 'unknown';
}

/**
 * Where the announced boundary transaction sits in epochs/index.json: 'none' (no boundary set, or not listed yet),
 * 'newest' (it is the publication of the newest epoch) or 'older' (a later epoch was published after it).
 */
export function boundaryPosition(index: IndexLike, boundaryTx: string | null, newestEpoch: number | null): 'none' | 'newest' | 'older' {
    if (!boundaryTx || !Array.isArray(index?.epochs)) return 'none';
    const at = index.epochs.find((e) => e && e.tx === boundaryTx);
    if (!at) return 'none';
    return at.epoch === newestEpoch ? 'newest' : 'older';
}

/**
 * Rewards rules from the newest file's version and the boundary: a version-3 file is 3; a version-2 file is 3 when it is
 * the announced last v2 epoch (burns after its publish transaction are v3), and 'unknown' when it is newer than the
 * announced boundary (the constant and the files disagree: fail-closed); otherwise the file's own version.
 */
export function rewardsFrom(fileVersion: Detected, boundary: 'none' | 'newest' | 'older'): Detected {
    if (fileVersion === 3) return 3;
    if (fileVersion === 2 && boundary === 'newest') return 3;
    if (fileVersion === 2 && boundary === 'older') return 'unknown';
    return fileVersion;
}

/** Why the Forge holds the burn instead of offering the v2 estimate (see v2EstimateAllowed); null = not held. */
export type BoundaryHold = null | 'tx-known' | 'date-reached' | 'read-failed';

/**
 * May the Forge offer the live (v2) estimate and the burn on v2 checks? Always while no boundary is announced (today:
 * the live behaviour, whatever the read state). Once a boundary is announced: only while detection positively reads
 * rewards 2, the boundary transaction is not named yet and the planned UTC date has not begun. From 00:00 UTC of that
 * date the last v2 publication can land at any moment and this release cannot see it until a later one names the
 * transaction, so the burn is held too. A known boundary transaction, a failed read, a pending read or a bad date blocks
 * it (the burn would be scored under rules this page cannot confirm).
 */
export function boundaryHold(rewards: Detected, boundary: { date: string; lastV2PublishTx: string | null } | null, nowMs: number = Date.now()): BoundaryHold {
    if (!boundary) return null;
    if (boundary.lastV2PublishTx) return 'tx-known';
    const start = /^\d{4}-\d{2}-\d{2}$/.test(boundary.date) ? Date.parse(`${boundary.date}T00:00:00Z`) : NaN;
    if (!Number.isFinite(start) || nowMs >= start) return 'date-reached';
    return rewards === 2 ? null : 'read-failed';
}

export function v2EstimateAllowed(rewards: Detected, boundary: { date: string; lastV2PublishTx: string | null } | null, nowMs: number = Date.now()): boolean {
    return boundaryHold(rewards, boundary, nowMs) === null;
}

const isVersion = (v: unknown): v is Version => v === 2 || v === 3;

/** Parses an override from a query string and the remembered value; `allowed` is false on the public site. */
export function parseOverride(search: string, remembered: string | null, allowed: boolean): { override: Override | null; remember: string | null | undefined } {
    if (!allowed) return { override: null, remember: undefined };
    const q = new URLSearchParams(search);
    if (q.get('mf_detect') === 'clear') return { override: null, remember: null };
    const num = (k: string): Version | undefined => {
        const v = Number(q.get(k));
        return isVersion(v) ? v : undefined;
    };
    const fromQuery: Override = {};
    const r = num('mf_rules');
    const w = num('mf_rewards');
    if (r) fromQuery.rules = r;
    if (w) fromQuery.rewards = w;
    if (fromQuery.rules || fromQuery.rewards) return { override: fromQuery, remember: JSON.stringify(fromQuery) };
    if (remembered) {
        try {
            const o = JSON.parse(remembered);
            const out: Override = {};
            if (isVersion(o?.rules)) out.rules = o.rules;
            if (isVersion(o?.rewards)) out.rewards = o.rewards;
            if (out.rules || out.rewards) return { override: out, remember: undefined };
        } catch { /* ignore a bad remembered value */ }
    }
    return { override: null, remember: undefined };
}

/** Override hosts: a local preview only, unless the build itself opted in. */
export function overrideAllowed(hostname: string, buildFlag: string | undefined): boolean {
    return buildFlag === '1' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/** The state components read: the override (previews) wins over what was detected. */
export function effective(s: DetectionState): DetectionState {
    if (!s.override) return s;
    return {
        ...s,
        rules: s.override.rules ?? s.rules,
        rewards: s.override.rewards ?? s.rewards,
        extraState: s.override.rules ? (s.override.rules === 3 ? s.extraState : null) : s.extraState,
    };
}

// ── the store (one read loop for the whole page) ─────────────────────────────────────────────────────────────
const RULES_EVERY_MS = 120_000;
const REWARDS_EVERY_MS = 600_000;
const OVERRIDE_KEY = 'moonforge_detect_override';

const initial = (): DetectionState => ({
    rules: 'unknown', rewards: 'unknown', pending: true, override: null, extraState: null, newestEpoch: null, newestVersion: null,
    boundaryPassed: false, rulesCheckedAt: null, rewardsCheckedAt: null, rulesError: null, rewardsError: null,
});

let raw: DetectionState = initial();
let snap: DetectionState = raw;
const listeners = new Set<() => void>();
let started = false;
let rulesDone = false;
let rewardsDone = false;

function publish(next: Partial<DetectionState>) {
    raw = { ...raw, ...next };
    raw.pending = !(rulesDone && rewardsDone);
    snap = effective(raw);
    listeners.forEach((l) => l());
}

function readOverride(): Override | null {
    if (typeof window === 'undefined') return null;
    const env = (import.meta as any).env?.VITE_MF_DETECT_OVERRIDE as string | undefined;
    const allowed = overrideAllowed(window.location.hostname, env);
    let remembered: string | null = null;
    try { remembered = window.sessionStorage.getItem(OVERRIDE_KEY); } catch { /* storage blocked */ }
    const { override, remember } = parseOverride(window.location.search, remembered, allowed);
    try {
        if (remember === null) window.sessionStorage.removeItem(OVERRIDE_KEY);
        else if (typeof remember === 'string') window.sessionStorage.setItem(OVERRIDE_KEY, remember);
    } catch { /* storage blocked: the query string still applies to this load */ }
    return override;
}

let connection: Connection | null = null;
const conn = () => (connection ??= new Connection(X1_RPC_DETECT, 'confirmed'));

export async function readRules(c: Connection = conn()): Promise<{ rules: Detected; extraState: ExtraStateView | null }> {
    const info = await c.getAccountInfo(EXTRA_STATE_PDA, 'confirmed');
    return rulesFromAccount(info ? { owner: info.owner, data: new Uint8Array(info.data) } : null);
}

const base = () => ((import.meta as any).env?.BASE_URL as string | undefined) ?? '/Moon-Forge/';
export async function readRewards(
    fetcher: typeof fetch = fetch, root = base(), boundaryTx: string | null = V3_BOUNDARY?.lastV2PublishTx ?? null,
): Promise<{ rewards: Detected; newestEpoch: number | null; newestVersion: number | null; boundaryPassed: boolean }> {
    const r = await fetcher(`${root}epochs/index.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`epochs/index.json: HTTP ${r.status}`);
    const index = (await r.json()) as IndexLike;
    const newest = newestEntry(index);
    if (!newest) return { rewards: 2, newestEpoch: null, newestVersion: null, boundaryPassed: false };
    const boundary = boundaryPosition(index, boundaryTx, newest.epoch);
    const boundaryPassed = boundary !== 'none';
    const f = await fetcher(`${root}epochs/epoch-${newest.epoch}.json`, { cache: 'no-store' });
    if (!f.ok) throw new Error(`epoch-${newest.epoch}.json: HTTP ${f.status}`);
    const file = await f.json();
    if (file?.epoch !== newest.epoch) return { rewards: 'unknown', newestEpoch: newest.epoch, newestVersion: null, boundaryPassed };
    const v = versionOfEpochFile(file);
    return { rewards: rewardsFrom(v, boundary), newestEpoch: newest.epoch, newestVersion: typeof file?.version === 'number' ? file.version : null, boundaryPassed };
}

async function checkRules() {
    try {
        const r = await readRules();
        rulesDone = true;
        publish({ rules: r.rules, extraState: r.extraState, rulesCheckedAt: Date.now(), rulesError: null });
    } catch (e: any) {
        rulesDone = true;
        // a failed read never downgrades a positive answer already seen in this tab (an RPC blip is not a rollback)
        publish({ rules: raw.rules === 3 ? 3 : 'unknown', rulesCheckedAt: Date.now(), rulesError: String(e?.message ?? e).slice(0, 200) });
    }
}

async function checkRewards() {
    try {
        const r = await readRewards();
        rewardsDone = true;
        publish({ ...r, rewardsCheckedAt: Date.now(), rewardsError: null });
    } catch (e: any) {
        rewardsDone = true;
        publish({ rewards: raw.rewards === 3 ? 3 : 'unknown', rewardsCheckedAt: Date.now(), rewardsError: String(e?.message ?? e).slice(0, 200) });
    }
}

function start() {
    if (started || typeof window === 'undefined') return;
    started = true;
    publish({ override: readOverride() });
    void checkRules();
    void checkRewards();
    setInterval(checkRules, RULES_EVERY_MS);
    setInterval(checkRewards, REWARDS_EVERY_MS);
}

export function subscribeDetection(l: () => void) {
    listeners.add(l);
    start();
    return () => { listeners.delete(l); };
}
export const getDetection = () => snap;

/** Detection for components: rules / rewards are 2, 3 or 'unknown' (treat anything but 3 as the live release). */
export function useDetection(): DetectionState {
    return useSyncExternalStore(subscribeDetection, getDetection, getDetection);
}
export const useRules3 = () => useDetection().rules === 3;
export const useRewards3 = () => useDetection().rewards === 3;

/** Test hook: resets the store. */
export function __resetDetectionForTests(next?: Partial<DetectionState>) {
    raw = { ...initial(), ...next };
    snap = effective(raw);
    rulesDone = rewardsDone = false;
    listeners.forEach((l) => l());
}
