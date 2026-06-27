# AudioQR Token Registry (Cloudflare Worker)

This is the backend that turns short tokens like `PRCH22` into full destination URLs. It runs as a single Cloudflare Worker backed by Workers KV. Free tier handles roughly 100,000 reads per day and 1,000 writes per day at no cost.

## Deploy with the wrangler CLI (recommended)

Prereqs: Node 18+ installed on your machine.

```bash
# One-time
npm install -g wrangler
wrangler login           # opens a browser to authorize

# From this directory
cd audio-qr/worker

# Create the KV namespace and copy its id into wrangler.toml
wrangler kv namespace create TOKENS
# The command prints an id; paste it into wrangler.toml under [[kv_namespaces]]

# Set your API key as a Worker secret
wrangler secret put API_KEY
# Wrangler prompts for the value. Paste your key. Do not commit it.

# Deploy
wrangler deploy
# Wrangler prints the live URL, something like:
# https://audioqr-registry.<your-account>.workers.dev
```

## Deploy via the dashboard (no CLI)

1. Go to https://dash.cloudflare.com -> Workers & Pages -> Create.
2. Pick the Hello World template, give it the name `audioqr-registry`, click Deploy.
3. After it deploys, open the worker -> Edit code -> replace the contents with the contents of `worker.js` in this folder. Save and deploy.
4. Go back to Cloudflare home -> Storage & Databases -> KV -> Create instance, name it `TOKENS`. Note the namespace id.
5. Back in the worker -> Settings -> Variables and Secrets:
   - Add a KV namespace binding: variable name `TOKENS`, namespace `TOKENS`.
   - Add a secret: name `API_KEY`, value your random key.
6. Redeploy (Settings -> Triggers may need a save).

## Endpoints

All endpoints accept and return JSON. CORS is open so the github.io listener can call from anywhere.

### `POST /api/tokens`  (requires `X-API-Key` header)

Body:
```json
{ "url": "https://example.com/page", "token": "OPTIONAL", "namespace": "default", "overwrite": false }
```

If `token` is omitted, a fresh 6-char Crockford Base32 token is minted (collision-safe). Returns `201` with the registered record.

Conflicts return `409` unless `overwrite: true`.

### `GET /api/resolve/:token`  (public)

```
GET /api/resolve/PRCH22
```

Returns `{ token, url, namespace, createdAt, hitCount }` or `404`. Increments `hitCount` asynchronously.

### `GET /api/list?namespace=default`  (requires `X-API-Key`)

Returns up to 1000 tokens in the namespace, newest first.

### `DELETE /api/tokens/:token?namespace=default`  (requires `X-API-Key`)

Revokes a token. Returns `404` if not present.

## Quick sanity check

After deploy, hit:

```bash
curl https://audioqr-registry.<your-account>.workers.dev/api/
```

Should return a JSON service banner.

Register the existing PRCH22 token:

```bash
curl -X POST https://audioqr-registry.<your-account>.workers.dev/api/tokens \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_KEY" \
  -d '{"url":"https://americanprobp.com/pages/porch.html","token":"PRCH22"}'
```

Resolve it:

```bash
curl https://audioqr-registry.<your-account>.workers.dev/api/resolve/PRCH22
```

## Operational notes

- KV is eventually consistent. After a `POST /api/tokens`, propagation worldwide is typically 1 to 2 seconds.
- The hitCount field is best-effort. Under heavy concurrent scan load some increments will be lost (no atomic counter in KV). Good enough for scan analytics.
- The API key is the only auth. Treat it like a password. If it leaks, set a new one with `wrangler secret put API_KEY` and rotate.
