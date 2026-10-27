/**
 * X1 RPC endpoints of the oracle, the keeper, the heartbeat and the health check (owner sheet 9.2: repository variable
 * X1_RPC_URLS).
 *
 * Order: the optional X1_RPC_URLS list (comma-separated), then the default endpoint X1_RPC (X1_RPC_URL, else the public
 * https://rpc.mainnet.x1.xyz), which stays the last fallback.
 *  - X1_RPC_URLS unset (or naming only the default): x1Connection() is exactly `new Connection(X1_RPC, commitment)`,
 *    as before this file existed. Nothing else changes.
 *  - X1_RPC_URLS set: every HTTP request goes to the first endpoint that answers. A transport error, a timeout, HTTP
 *    429 or 5xx moves the request to the next endpoint (the default last); after a switch the preferred endpoint is
 *    tried again after FAILBACK_MS. A listed endpoint is used only once its genesis hash equals X1 mainnet's
 *    (X1_GENESIS_HASH overrides it, for a test cluster): a testnet or devnet URL is skipped with a warning, never used.
 *    The websocket (transaction confirmations) stays on the default endpoint, as before.
 *  - R-5: a listed endpoint serves availability, never trust. The genesis check proves the cluster, not honest or
 *    complete answers, so every read that releases a keeper preimage or decides the upgrade verdict (the keeper seat,
 *    the Bet and JackpotRound lists before a reveal, SlotHashes, the W2-4 probe) goes to the default endpoint alone
 *    (trustedConnectionFor).
 * R-8: X1_RPC_URLS is a repository VARIABLE, and GitHub prints the env of every step in the run logs, which are public
 * for this repository. Only KEYLESS endpoints belong in it (no API key in the path or the query); the health check
 * warns about an entry with a path or a query (x1RpcWithPath). A keyed endpoint belongs in the X1_RPC_URL secret.
 * Only the host of an entry is ever printed by this code.
 */
import { Commitment, Connection } from "@solana/web3.js";
import { X1_RPC } from "./config";

/** Genesis hash of X1 mainnet (the same constant as agents/kit/moonforge.mjs X1_MAINNET_GENESIS). */
export const X1_MAINNET_GENESIS = "4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN";
/** A listed endpoint that does not answer within this long counts as down (the default endpoint keeps no limit, as before). */
export const LISTED_TIMEOUT_MS = 30_000;
/** After a failover, the preferred endpoint is tried again after this long. */
export const FAILBACK_MS = 5 * 60_000;

/** The host of an RPC URL (never the path or the query, which may carry a key). */
export function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid URL";
  }
}

const entries = (env: Record<string, string | undefined>) => (env.X1_RPC_URLS || "").split(",").map((u) => u.trim()).filter(Boolean);
const isHttpUrl = (u: string) => {
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:";
  } catch {
    return false;
  }
};

/**
 * X1 endpoints in order: X1_RPC_URLS (trimmed, empty entries dropped), then the default; duplicates removed. An entry
 * that is not an http(s) URL (a typo) is left out, so it can never stop a run: x1RpcIgnored counts it, the health check
 * reports it.
 */
export function x1RpcList(env: Record<string, string | undefined> = process.env, fallback: string = X1_RPC): string[] {
  return [...new Set([...entries(env).filter(isHttpUrl), fallback])];
}

/** How many X1_RPC_URLS entries are not http(s) URLs (never printed: an entry may carry a key). */
export function x1RpcIgnored(env: Record<string, string | undefined> = process.env): number {
  return entries(env).filter((u) => !isHttpUrl(u)).length;
}

/**
 * R-8: how many X1_RPC_URLS entries have a path longer than "/" or a query (where an API key would sit). The variable
 * is printed in public run logs, so such an entry is a warning in the health check; the entries are never printed.
 */
export function x1RpcWithPath(env: Record<string, string | undefined> = process.env): number {
  return entries(env).filter(isHttpUrl).filter((u) => {
    const p = new URL(u);
    return (p.pathname !== "" && p.pathname !== "/") || p.search !== "" || p.username !== "" || p.password !== "";
  }).length;
}

const trustedCache = new Map<string, Connection>();
/**
 * R-5: the connection for reads that release a keeper preimage or decide the upgrade verdict. X1_RPC_URLS unset (one
 * endpoint): `c` itself, which already is the default endpoint (and any injected test connection stays as it is). Set:
 * a plain Connection to the default endpoint X1_RPC only, never a listed endpoint.
 */
export function trustedConnectionFor(c: Connection, env: Record<string, string | undefined> = process.env, fallback: string = X1_RPC): Connection {
  if (x1RpcList(env, fallback).length === 1) return c;
  const commitment = (c as { commitment?: Commitment }).commitment ?? "confirmed";
  const k = `${fallback}|${commitment}`;
  let t = trustedCache.get(k);
  if (!t) {
    t = new Connection(fallback, commitment);
    trustedCache.set(k, t);
  }
  return t;
}

/** web3.js makeWebsocketUrl, so the websocket stays where `new Connection(endpoint)` would put it. */
export function websocketUrlOf(endpoint: string): string {
  const m = endpoint.match(/^[^:]+:\/\/([^:[]+|\[[^\]]+\])(:\d+)?(.*)/i);
  if (!m) throw new TypeError(`Failed to validate endpoint URL \`${endpoint}\``);
  const [, hostish, portWithColon, rest] = m;
  const protocol = endpoint.startsWith("https:") ? "wss:" : "ws:";
  const port = portWithColon == null ? "" : `:${parseInt(portWithColon.slice(1), 10) + 1}`;
  return `${protocol}//${hostish}${port}${rest}`;
}

type FetchLike = (input: string, init?: any) => Promise<Response>;

export interface FailoverOpts {
  /** genesis hash every listed endpoint must report (default X1_GENESIS_HASH or X1 mainnet's) */
  genesis?: string;
  fetch?: FetchLike;
  log?: (s: string) => void;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * The fetch given to web3.js when X1_RPC_URLS is set. `urls` = x1RpcList(): the last one is the default endpoint,
 * trusted as before (no genesis read, no timeout); the others are used only after their genesis check passed.
 * Returns the first response that is neither 429 nor 5xx; when every endpoint failed, the last HTTP response (so
 * web3.js handles it as it always did, including its own 429 back-off) or, with none, the last transport error.
 */
export function failoverFetch(urls: string[], o: FailoverOpts = {}): FetchLike {
  if (!urls.length) throw new Error("failoverFetch: no endpoint");
  const doFetch: FetchLike = o.fetch ?? ((u, i) => globalThis.fetch(u, i));
  const log = o.log ?? ((s: string) => console.warn(s));
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? LISTED_TIMEOUT_MS;
  const genesis = o.genesis ?? (process.env.X1_GENESIS_HASH || X1_MAINNET_GENESIS);
  const trusted = urls.length - 1;
  const checks = new Map<number, Promise<boolean>>();
  let current = 0;
  let switchedAt = 0;

  const withTimeout = (i: number, init?: any) => (i === trusted || init?.signal ? init : { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const clusterOk = (i: number): Promise<boolean> => {
    if (i === trusted) return Promise.resolve(true);
    let p = checks.get(i);
    if (!p) {
      p = doFetch(urls[i], withTimeout(i, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }) }))
        .then(async (r) => {
          const g = r.ok ? ((await r.json()) as any)?.result : null;
          if (g === genesis) return true;
          log(`X1 RPC ${rpcHost(urls[i])}: genesis ${g ?? `unreadable (HTTP ${r.status})`} is not X1 mainnet's (${genesis}): this endpoint is never used`);
          if (!r.ok) checks.delete(i); // an HTTP error is retried later; a wrong cluster stays refused
          return false;
        })
        .catch((e) => {
          checks.delete(i); // a transport error: checked again on a later request
          log(`X1 RPC ${rpcHost(urls[i])}: genesis check failed (${String((e as Error)?.message ?? e).slice(0, 80)})`);
          return false;
        });
      checks.set(i, p);
    }
    return p;
  };

  return async (_input: string, init?: any): Promise<Response> => {
    if (current !== 0 && now() - switchedAt >= FAILBACK_MS) current = 0;
    let lastResponse: Response | null = null;
    let lastError: unknown = null;
    for (let k = 0; k < urls.length; k++) {
      const i = (current + k) % urls.length;
      if (!(await clusterOk(i))) continue;
      try {
        const r = await doFetch(urls[i], withTimeout(i, init));
        if (r.status === 429 || r.status >= 500) {
          lastResponse = r;
          continue;
        }
        if (i !== current) {
          log(`X1 RPC failover: ${rpcHost(urls[current])} -> ${rpcHost(urls[i])}`);
          current = i;
          switchedAt = now();
        }
        return r;
      } catch (e) {
        lastError = e;
      }
    }
    if (lastResponse) return lastResponse;
    throw lastError ?? new Error("no X1 RPC endpoint passed its genesis check");
  };
}

/**
 * The X1 connection every module uses. X1_RPC_URLS unset: `new Connection(X1_RPC, commitment)`, unchanged. Set: the
 * first listed endpoint, the failover fetch above, and the websocket of the default endpoint.
 */
export function x1Connection(commitment: Commitment = "confirmed", env: Record<string, string | undefined> = process.env): Connection {
  const urls = x1RpcList(env);
  if (urls.length === 1) return new Connection(urls[0], commitment);
  return new Connection(urls[0], { commitment, fetch: failoverFetch(urls) as any, wsEndpoint: websocketUrlOf(urls[urls.length - 1]) });
}
