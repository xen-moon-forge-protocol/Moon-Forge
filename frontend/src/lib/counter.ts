/**
 * The public counter: XEN removed from supply through Moon Forge, per chain, and the XNT the published epochs set aside
 * for burners, computed only from the published epoch files (frontend/public/epochs, each one hash-committed on X1 and
 * recomputable with the oracle's verifier). The site shows it (components/PublicCounter.tsx) and the prerender writes it
 * as dist/counter.json so anyone, people or AI assistants, can quote one small machine-readable file.
 *
 * Counted: every burn listed in a published base epoch file (the portal calls XEN's own burn(), which removes the XEN
 * from that chain's supply), once, by chain id + transaction hash + log index; burns of the current week appear when their
 * epoch is published. XNT: the net budget each epoch file records at publication (publish.budget, what the program set
 * aside for that epoch's leaves; unclaimed amounts return to the pool after 90 days), never an estimate.
 *
 * Pure: no React, no network.
 */
export const COUNTER_KIND = 'moonforge-public-counter';

export interface CounterChain { chainId: number; name: string; burns: number; xenWei: string; xen: string }
export interface PublicCounter {
    kind: typeof COUNTER_KIND;
    version: 1;
    programId: string | null;
    /** newest epoch counted, and when its file was created (UTC ISO) */
    newestEpoch: number | null;
    asOf: string | null;
    epochs: number;
    chains: CounterChain[];
    burns: number;
    xenWei: string;
    xen: string;
    /** Σ publish.budget over the epochs that record it (lamports) */
    xntSetAsideLamports: string;
    xntSetAside: string;
    /** epochs whose file records no publish.budget (not counted in xntSetAside) */
    epochsWithoutBudget: number[];
    notes: string[];
}

const DIGITS = /^(0|[1-9][0-9]*)$/;
const big = (v: unknown): bigint | null => (typeof v === 'string' && DIGITS.test(v) ? BigInt(v) : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null);

/** Fixed-point decimal of an integer amount with `decimals` places, trimmed to at most `keep` decimals. */
export function decimal(amount: bigint, decimals: number, keep = 2): string {
    const unit = 10n ** BigInt(decimals);
    const whole = amount / unit;
    const frac = (amount % unit).toString().padStart(decimals, '0').slice(0, keep).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * Builds the counter from epoch files (any order). A file that is not an epoch file (no numeric `epoch` or no `burns`
 * array) throws: the counter is never built from a partial or malformed set.
 */
export function summarizeEpochFiles(files: unknown[]): PublicCounter {
    const chains = new Map<number, { name: string; burns: number; wei: bigint }>();
    const seen = new Set<string>();
    let lamports = 0n;
    let newest: { epoch: number; createdAt: string | null } | null = null;
    let programId: string | null = null;
    const noBudget: number[] = [];
    const epochs = new Set<number>();
    for (const f of files as any[]) {
        if (!f || typeof f !== 'object' || !Number.isSafeInteger(f.epoch) || f.epoch < 1 || !Array.isArray(f.burns)) throw new Error('counter: not an epoch file');
        if (epochs.has(f.epoch)) throw new Error(`counter: epoch ${f.epoch} given twice`);
        epochs.add(f.epoch);
        if (typeof f.programId === 'string') programId = programId ?? f.programId;
        if (!newest || f.epoch > newest.epoch) newest = { epoch: f.epoch, createdAt: typeof f.createdAt === 'string' ? f.createdAt : null };
        const names = new Map<number, string>();
        for (const c of Array.isArray(f.chains) ? f.chains : []) if (Number.isSafeInteger(c?.chainId) && typeof c?.name === 'string') names.set(c.chainId, c.name);
        for (const b of f.burns) {
            const wei = big(b?.amountWei);
            if (!Number.isSafeInteger(b?.chainId) || wei === null || typeof b?.txHash !== 'string') throw new Error(`counter: epoch ${f.epoch} lists a malformed burn`);
            const key = `${b.chainId}:${b.txHash.toLowerCase()}:${b.logIndex ?? ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const c = chains.get(b.chainId) ?? { name: names.get(b.chainId) ?? `chain ${b.chainId}`, burns: 0, wei: 0n };
            if (c.name.startsWith('chain ') && names.has(b.chainId)) c.name = names.get(b.chainId)!;
            c.burns += 1;
            c.wei += wei;
            chains.set(b.chainId, c);
        }
        const budget = big(f.publish?.budget);
        if (budget === null) noBudget.push(f.epoch);
        else lamports += budget;
    }
    const list = [...chains.entries()].sort((a, b) => a[0] - b[0]).map(([chainId, c]) => ({ chainId, name: c.name, burns: c.burns, xenWei: c.wei.toString(), xen: decimal(c.wei, 18) }));
    const totalWei = list.reduce((s, c) => s + BigInt(c.xenWei), 0n);
    return {
        kind: COUNTER_KIND, version: 1, programId, newestEpoch: newest?.epoch ?? null, asOf: newest?.createdAt ?? null, epochs: epochs.size,
        chains: list, burns: seen.size, xenWei: totalWei.toString(), xen: decimal(totalWei, 18),
        xntSetAsideLamports: lamports.toString(), xntSetAside: decimal(lamports, 9, 4), epochsWithoutBudget: noBudget.sort((a, b) => a - b),
        notes: [
            'XEN: every burn listed in a published Moon Forge epoch file, counted once per chain. The portals call the XEN contract\'s own burn(), which removes that XEN from the chain\'s supply. Burns of the current week are counted once their epoch is published.',
            'XNT: the net budget each published epoch set aside for its burners at publication (publish.budget in the epoch file). Burners claim it within 90 days; what is not claimed goes back to the reward pool. The amounts actually claimed are on X1 (Epoch accounts) and on the Transparency page.',
            'Source: epochs/index.json and epochs/epoch-N.json on this site; each file is hash-committed on X1 and can be recomputed with the oracle verifier (cd oracle && npm run verify -- epoch-N.json --full).',
        ],
    };
}

/** True when a counter file describes the same newest epoch the index lists (otherwise recompute from the files). */
export const counterMatchesIndex = (c: Partial<PublicCounter> | null | undefined, newestInIndex: number | null) =>
    !!c && c.kind === COUNTER_KIND && c.version === 1 && c.newestEpoch === newestInIndex;
