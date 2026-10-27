/**
 * X1 RPC list and failover (no network: a fake fetch).
 *   npx ts-node test/x1-rpc.test.ts
 */
import assert from "assert";
import { Connection } from "@solana/web3.js";
import { failoverFetch, rpcHost, trustedConnectionFor, websocketUrlOf, x1Connection, X1_MAINNET_GENESIS, x1RpcIgnored, x1RpcList, x1RpcWithPath } from "../src/x1-rpc";

let n = 0;
const tests: [string, () => Promise<void> | void][] = [];
const t = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const DEFAULT = "https://rpc.mainnet.x1.xyz";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** fake endpoints: per URL, its genesis and how it answers a normal request ("ok", an HTTP status, or "down") */
function fakeNet(spec: Record<string, { genesis?: string; answer: "ok" | number | "down" }>) {
  const calls: string[] = [];
  const fetch = async (url: string, init?: any): Promise<Response> => {
    const s = spec[url];
    const method = JSON.parse(init?.body ?? "{}").method;
    calls.push(`${rpcHost(url)}:${method}`);
    if (!s || s.answer === "down") throw new TypeError("fetch failed");
    if (method === "getGenesisHash") return json({ jsonrpc: "2.0", id: 1, result: s.genesis ?? X1_MAINNET_GENESIS });
    if (typeof s.answer === "number") return json({ error: "x" }, s.answer);
    return json({ jsonrpc: "2.0", id: 1, result: rpcHost(url) });
  };
  return { fetch, calls };
}
const req = { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }) };
const answer = async (r: Response) => ((await r.json()) as any).result;

t("the list: X1_RPC_URLS first (trimmed, empty entries dropped), the default last, duplicates removed", () => {
  assert.deepEqual(x1RpcList({}, DEFAULT), [DEFAULT]);
  assert.deepEqual(x1RpcList({ X1_RPC_URLS: "" }, DEFAULT), [DEFAULT], "an empty repository variable arrives as \"\"");
  assert.deepEqual(x1RpcList({ X1_RPC_URLS: " https://a.example/k1 , ,https://b.example " }, DEFAULT), ["https://a.example/k1", "https://b.example", DEFAULT]);
  assert.deepEqual(x1RpcList({ X1_RPC_URLS: `${DEFAULT},https://a.example` }, DEFAULT), [DEFAULT, "https://a.example"], "the default named first stays first; the list order wins");
  assert.deepEqual(x1RpcList({ X1_RPC_URLS: DEFAULT }, DEFAULT), [DEFAULT]);
});
t("a typo in X1_RPC_URLS can never stop a run: entries that are not http(s) URLs are left out and counted", () => {
  const env = { X1_RPC_URLS: "rpc.example.com,https://a.example,wss://b.example,https//c" };
  assert.deepEqual(x1RpcList(env, DEFAULT), ["https://a.example", DEFAULT]);
  assert.equal(x1RpcIgnored(env), 3);
  assert.equal(x1RpcIgnored({}), 0);
  assert.equal(x1Connection("confirmed", { X1_RPC_URLS: "not a url" }).rpcEndpoint, DEFAULT, "only typos: exactly the default connection");
});
t("unset: exactly new Connection(X1_RPC) (same endpoint, same websocket, no custom fetch)", () => {
  const c = x1Connection("confirmed", {});
  assert.ok(c instanceof Connection);
  assert.equal(c.rpcEndpoint, DEFAULT);
  assert.equal((c as any)._rpcWsEndpoint, new Connection(DEFAULT, "confirmed").rpcEndpoint.replace("https:", "wss:"));
  assert.equal(c.commitment, "confirmed");
});
t("set: the first listed endpoint, the websocket of the default endpoint", () => {
  const c = x1Connection("confirmed", { X1_RPC_URLS: "https://a.example/key" });
  assert.equal(c.rpcEndpoint, "https://a.example/key");
  assert.equal((c as any)._rpcWsEndpoint, "wss://rpc.mainnet.x1.xyz");
});
t("websocket URL mirrors web3.js (port + 1 only when explicit)", () => {
  assert.equal(websocketUrlOf("https://rpc.mainnet.x1.xyz"), "wss://rpc.mainnet.x1.xyz");
  assert.equal(websocketUrlOf("http://127.0.0.1:8899"), "ws://127.0.0.1:8900");
  assert.equal(websocketUrlOf("https://h.example/path?k=1"), "wss://h.example/path?k=1");
});
t("the host only is ever printed (a key in the path or query stays out)", () => {
  assert.equal(rpcHost("https://h.example/v1/SECRET?api-key=SECRET"), "h.example");
  assert.equal(rpcHost("not a url"), "invalid URL");
});
t("a healthy listed endpoint is used, after its genesis check (once)", async () => {
  const net = fakeNet({ "https://a.example": { answer: "ok" }, [DEFAULT]: { answer: "ok" } });
  const f = failoverFetch(["https://a.example", DEFAULT], { fetch: net.fetch, log: () => {} });
  assert.equal(await answer(await f("ignored", req)), "a.example");
  assert.equal(await answer(await f("ignored", req)), "a.example");
  assert.deepEqual(net.calls, ["a.example:getGenesisHash", "a.example:getSlot", "a.example:getSlot"]);
});
t("down, 429 or 5xx: the request moves to the next endpoint, the default last", async () => {
  for (const bad of ["down", 429, 503] as const) {
    const logs: string[] = [];
    const net = fakeNet({ "https://a.example": { answer: bad }, [DEFAULT]: { answer: "ok" } });
    const f = failoverFetch(["https://a.example", DEFAULT], { fetch: net.fetch, log: (s) => logs.push(s) });
    assert.equal(await answer(await f("ignored", req)), "rpc.mainnet.x1.xyz", `listed endpoint ${bad}`);
    assert.ok(logs.some((l) => /failover: a\.example -> rpc\.mainnet\.x1\.xyz/.test(l)), `failover logged (${bad})`);
  }
});
t("a listed endpoint on another cluster is never used (and never asked again)", async () => {
  const logs: string[] = [];
  const net = fakeNet({ "https://testnet.example": { genesis: "OtherGenesis", answer: "ok" }, [DEFAULT]: { answer: "ok" } });
  const f = failoverFetch(["https://testnet.example", DEFAULT], { fetch: net.fetch, log: (s) => logs.push(s) });
  assert.equal(await answer(await f("ignored", req)), "rpc.mainnet.x1.xyz");
  assert.equal(await answer(await f("ignored", req)), "rpc.mainnet.x1.xyz");
  assert.deepEqual(net.calls.filter((c) => c.startsWith("testnet")), ["testnet.example:getGenesisHash"]);
  assert.ok(logs.some((l) => /is not X1 mainnet's/.test(l)));
});
t("after a failover the preferred endpoint is tried again after FAILBACK_MS", async () => {
  let now = 0;
  const spec: Record<string, { answer: "ok" | number | "down" }> = { "https://a.example": { answer: "down" }, [DEFAULT]: { answer: "ok" } };
  const net = fakeNet(spec);
  const f = failoverFetch(["https://a.example", DEFAULT], { fetch: net.fetch, log: () => {}, now: () => now });
  assert.equal(await answer(await f("ignored", req)), "rpc.mainnet.x1.xyz");
  spec["https://a.example"].answer = "ok";
  now = 60_000;
  assert.equal(await answer(await f("ignored", req)), "rpc.mainnet.x1.xyz", "still on the default one minute later");
  now = 5 * 60_000 + 1;
  assert.equal(await answer(await f("ignored", req)), "a.example", "back on the preferred endpoint");
});
t("every endpoint failing: the last HTTP answer is returned (web3.js handles it as before), else the transport error", async () => {
  const f1 = failoverFetch(["https://a.example", DEFAULT], { fetch: fakeNet({ "https://a.example": { answer: "down" }, [DEFAULT]: { answer: 429 } }).fetch, log: () => {} });
  assert.equal((await f1("ignored", req)).status, 429);
  const f2 = failoverFetch(["https://a.example", DEFAULT], { fetch: fakeNet({ "https://a.example": { answer: "down" }, [DEFAULT]: { answer: "down" } }).fetch, log: () => {} });
  await assert.rejects(f2("ignored", req), /fetch failed/);
});
t("the default endpoint is trusted as before: no genesis read, no added timeout", async () => {
  const seen: any[] = [];
  const f = failoverFetch([DEFAULT], { fetch: async (u, i) => { seen.push(i); return json({ result: 1 }); }, log: () => {} });
  await f("ignored", req);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], req, "the request options are passed through unchanged");
});

t("R-5: reads that release a preimage or decide the verdict use the default endpoint only (trustedConnectionFor)", () => {
  const c = new Connection("https://a.example", "confirmed");
  assert.equal(trustedConnectionFor(c, {}, DEFAULT), c, "X1_RPC_URLS unset: the connection itself (already the default)");
  assert.equal(trustedConnectionFor(c, { X1_RPC_URLS: "" }, DEFAULT), c);
  const t1 = trustedConnectionFor(c, { X1_RPC_URLS: "https://a.example,https://b.example" }, DEFAULT);
  assert.notEqual(t1, c);
  assert.equal(t1.rpcEndpoint, DEFAULT, "never a listed endpoint");
  assert.equal(trustedConnectionFor(c, { X1_RPC_URLS: "https://a.example" }, DEFAULT), t1, "one connection, reused");
});
t("R-8: entries with a path or a query (where a key would sit) are counted for the health warning, never printed", () => {
  assert.equal(x1RpcWithPath({}), 0);
  assert.equal(x1RpcWithPath({ X1_RPC_URLS: "https://a.example,https://b.example/" }), 0, "a bare host or '/' is keyless");
  assert.equal(x1RpcWithPath({ X1_RPC_URLS: "https://a.example/k1,https://b.example?api-key=x,https://u:p@c.example,not a url" }), 3);
});

(async () => {
  for (const [name, fn] of tests) {
    await fn();
    n++;
    console.log(`  ok  ${name}`);
  }
  console.log(`x1 rpc: ${n} tests passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
