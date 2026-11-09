// A small local HTTP/JSON interface (off by default) so another agent can ask this bot for a quote or a plan.
// It never signs on request: /quote and /plan are read-only dry runs; /tick runs one normal tick only when the owner set
// a2a.allowActions, and that tick obeys every limit of the config and sends only if the bot itself was started with --live.
// Binds to 127.0.0.1 by default; any other host requires a bearer token (from the environment, never from the config).
import http from 'node:http';
import crypto from 'node:crypto';

const MAX_BODY = 16 * 1024;
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
};
const sameToken = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => {
      if (!parts.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { reject(Object.assign(new Error('body is not JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/**
 * handlers: { card(), status(), quote({ chainId, amountXen }), plan(), tick() }
 * Returns the http.Server (listening). `token` null means no token (loopback only; config validation enforces it).
 */
export function startA2A({ host = '127.0.0.1', port = 8787, token = null, allowActions = false, handlers, log = () => {} }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      if (url.pathname === '/.well-known/agent-card.json' || url.pathname === '/agent-card.json') return json(res, 200, await handlers.card());
      if (token && !sameToken((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''), token)) return json(res, 401, { error: 'unauthorized' });
      if (req.method === 'GET' && url.pathname === '/status') return json(res, 200, await handlers.status());
      if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
      const body = await readBody(req);
      if (url.pathname === '/quote') {
        if (!/^\d+$/.test(String(body.chainId ?? '')) || !/^\d+(\.\d+)?$/.test(String(body.amountXen ?? ''))) return json(res, 400, { error: 'pass { "chainId": 10, "amountXen": "1000000" }' });
        return json(res, 200, await handlers.quote({ chainId: Number(body.chainId), amountXen: String(body.amountXen) }));
      }
      if (url.pathname === '/plan') return json(res, 200, await handlers.plan());
      if (url.pathname === '/tick') {
        if (!allowActions) return json(res, 403, { error: 'actions are off: the owner has not set a2a.allowActions' });
        log('a2a: tick requested by a client');
        return json(res, 200, await handlers.tick());
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, e.status ?? 500, { error: String(e?.message ?? e).slice(0, 200) });
    }
  });
  server.listen(port, host);
  return server;
}
