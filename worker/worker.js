// AudioQR Token Registry Worker
// ------------------------------
// Cloudflare Worker that backs the audio-qr listener and encoder.
// Three endpoints:
//
//   POST /api/tokens         (auth)  Register a new token. Body: { url, token?, namespace? }
//   GET  /api/resolve/:token (public) Resolve a token to its URL. Returns { url, namespace }.
//   GET  /api/list           (auth)  List all tokens. Optional ?namespace=... filter.
//   DELETE /api/tokens/:token (auth) Revoke a token.
//
// Storage layout in KV:
//   key = "<namespace>:<token>"  e.g. "default:PRCH22"
//   value = JSON string: { url, namespace, token, createdAt, hitCount }
//
// Auth: a single shared API key in the X-API-Key header for write endpoints.
// CORS: open (so the github.io listener can call it from any device).

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TOKEN_LEN = 6;
const TOKEN_REGEX = /^[0-9A-HJKMNP-TV-Z]{3,8}$/i;
const NAMESPACE_REGEX = /^[a-z0-9-]{1,32}$/;
const DEFAULT_NAMESPACE = "default";

// ----------------------------------------------------------------------------
// Token utilities
// ----------------------------------------------------------------------------

function generateToken(len = TOKEN_LEN) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += CROCKFORD[bytes[i] & 31];
  return out;
}

function normalizeToken(s) {
  if (typeof s !== "string") return null;
  const cleaned = s.trim().toUpperCase()
    .replace(/I/g, "1").replace(/L/g, "1")
    .replace(/O/g, "0").replace(/U/g, "V");
  return TOKEN_REGEX.test(cleaned) ? cleaned : null;
}

function kvKey(namespace, token) {
  return `${namespace}:${token}`;
}

// ----------------------------------------------------------------------------
// HTTP helpers
// ----------------------------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

function checkAuth(request, env) {
  const expected = env.API_KEY;
  if (!expected) return false;
  const got = request.headers.get("X-API-Key");
  // Constant-time-ish comparison (Workers do not provide timingSafeEqual).
  if (!got || got.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ got.charCodeAt(i);
  }
  return mismatch === 0;
}

// ----------------------------------------------------------------------------
// Handlers
// ----------------------------------------------------------------------------

async function handleResolve(request, env, token) {
  const norm = normalizeToken(token);
  if (!norm) return error("Invalid token format", 400);

  // Try each namespace until we find a match. For now, only the default
  // namespace, but namespaced lookups (?namespace=) override.
  const url = new URL(request.url);
  const ns = url.searchParams.get("namespace") || DEFAULT_NAMESPACE;
  if (!NAMESPACE_REGEX.test(ns)) return error("Invalid namespace", 400);

  const raw = await env.TOKENS.get(kvKey(ns, norm));
  if (!raw) return error("Token not found", 404);

  let rec;
  try { rec = JSON.parse(raw); } catch { return error("Corrupt registry entry", 500); }

  // Async hit-count update (do not block the response).
  rec.hitCount = (rec.hitCount || 0) + 1;
  rec.lastHitAt = new Date().toISOString();
  // Use waitUntil to update KV after response is sent.
  // Not awaited so the redirect lookup stays fast.
  env._ctx && env._ctx.waitUntil(env.TOKENS.put(kvKey(ns, norm), JSON.stringify(rec)));

  return json({
    token: norm,
    url: rec.url,
    namespace: ns,
    createdAt: rec.createdAt,
    hitCount: rec.hitCount,
  });
}

async function handleRegister(request, env) {
  if (!checkAuth(request, env)) return error("Unauthorized", 401);

  let body;
  try { body = await request.json(); }
  catch { return error("Invalid JSON body", 400); }

  const { url: destUrl, token: tokenIn, namespace: nsIn, overwrite } = body || {};

  if (!destUrl || typeof destUrl !== "string") return error("Missing url", 400);
  // Basic URL validation.
  let parsed;
  try { parsed = new URL(destUrl); }
  catch { return error("Invalid url", 400); }
  if (!/^https?:$/.test(parsed.protocol)) return error("url must be http or https", 400);

  const ns = nsIn || DEFAULT_NAMESPACE;
  if (!NAMESPACE_REGEX.test(ns)) return error("Invalid namespace (a-z, 0-9, -, max 32)", 400);

  // Token: caller-supplied or auto-generated.
  let token = tokenIn ? normalizeToken(tokenIn) : null;
  if (tokenIn && !token) return error("Token must be 3-8 Crockford Base32 chars", 400);

  if (token) {
    // Caller-supplied: check for collision.
    const existing = await env.TOKENS.get(kvKey(ns, token));
    if (existing && !overwrite) {
      const rec = JSON.parse(existing);
      if (rec.url === destUrl) {
        // Already registered to same URL. Idempotent success.
        return json({ token, url: rec.url, namespace: ns, createdAt: rec.createdAt, idempotent: true });
      }
      return error(`Token ${token} already maps to a different URL. Use overwrite:true to replace, or pick a new token.`, 409);
    }
  } else {
    // Auto-generate. Retry on collision.
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = generateToken(TOKEN_LEN);
      const existing = await env.TOKENS.get(kvKey(ns, candidate));
      if (!existing) { token = candidate; break; }
    }
    if (!token) return error("Could not mint a unique token after 10 tries (registry very full)", 500);
  }

  const rec = {
    url: destUrl,
    namespace: ns,
    token,
    createdAt: new Date().toISOString(),
    hitCount: 0,
  };
  await env.TOKENS.put(kvKey(ns, token), JSON.stringify(rec));
  return json({ token, url: destUrl, namespace: ns, createdAt: rec.createdAt }, 201);
}

async function handleList(request, env) {
  if (!checkAuth(request, env)) return error("Unauthorized", 401);

  const url = new URL(request.url);
  const ns = url.searchParams.get("namespace") || DEFAULT_NAMESPACE;
  if (!NAMESPACE_REGEX.test(ns)) return error("Invalid namespace", 400);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "1000", 10), 1000);

  const prefix = ns + ":";
  const list = await env.TOKENS.list({ prefix, limit });
  const items = [];
  for (const k of list.keys) {
    const raw = await env.TOKENS.get(k.name);
    if (raw) {
      try { items.push(JSON.parse(raw)); } catch {}
    }
  }
  items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return json({ namespace: ns, count: items.length, items });
}

async function handleDelete(request, env, token) {
  if (!checkAuth(request, env)) return error("Unauthorized", 401);
  const norm = normalizeToken(token);
  if (!norm) return error("Invalid token format", 400);
  const url = new URL(request.url);
  const ns = url.searchParams.get("namespace") || DEFAULT_NAMESPACE;
  if (!NAMESPACE_REGEX.test(ns)) return error("Invalid namespace", 400);

  const key = kvKey(ns, norm);
  const existing = await env.TOKENS.get(key);
  if (!existing) return error("Token not found", 404);
  await env.TOKENS.delete(key);
  return json({ deleted: norm, namespace: ns });
}

// ----------------------------------------------------------------------------
// Router
// ----------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    env._ctx = ctx;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Health check / root.
    if (path === "/" || path === "/api" || path === "/api/") {
      return json({
        service: "audioqr-registry",
        version: "1.0",
        endpoints: [
          "GET  /api/resolve/:token",
          "POST /api/tokens",
          "GET  /api/list",
          "DELETE /api/tokens/:token",
        ],
      });
    }

    // GET /api/resolve/:token
    const resolveMatch = path.match(/^\/api\/resolve\/([^/]+)$/);
    if (resolveMatch && method === "GET") {
      return handleResolve(request, env, decodeURIComponent(resolveMatch[1]));
    }

    // POST /api/tokens
    if (path === "/api/tokens" && method === "POST") {
      return handleRegister(request, env);
    }

    // GET /api/list
    if (path === "/api/list" && method === "GET") {
      return handleList(request, env);
    }

    // DELETE /api/tokens/:token
    const deleteMatch = path.match(/^\/api\/tokens\/([^/]+)$/);
    if (deleteMatch && method === "DELETE") {
      return handleDelete(request, env, decodeURIComponent(deleteMatch[1]));
    }

    return error("Not found", 404);
  },
};
