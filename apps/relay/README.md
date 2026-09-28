# tether-relay

Forwards Tether push notifications to Apple. Nothing else.

## Why it exists

APNs will only accept a push signed with a credential belonging to the team that
publishes the app. A self-hosted Tether server cannot hold that credential —
shipping it would hand every self-hoster a key that can push to every Tether
user, and distributing it violates Apple's Developer Program License Agreement.
So one relay, run by whoever publishes the app, holds the key.

## What it can and cannot see

It receives `{ token, ciphertext }`. The ciphertext is AES-256-GCM sealed with a
key generated on the user's device and shared only with their own Tether
servers. The relay has no way to read it, and the iOS Notification Service
Extension decrypts it after delivery.

It stores nothing. No database, no accounts, no payload logging.

## Deploy it separately

The relay is a Cloudflare Worker, so it never sits beside a Tether server: a
Tether server is a remote shell on the machine hosting it, and the relay holds
the APNs key.

```sh
cd apps/relay
bunx wrangler login
bunx wrangler deploy
bunx wrangler secret put APNS_KEY_ID
bunx wrangler secret put APNS_TEAM_ID
bunx wrangler secret put APNS_BUNDLE_ID
bunx wrangler secret put APNS_PRIVATE_KEY < AuthKey_XXXXXXXXXX.p8
```

Then attach a hostname under **Workers & Pages → tether-relay → Settings →
Domains & Routes → Add → Custom domain**. `wrangler.jsonc` deliberately has no
account or routes, so a deploy never needs them in the repo; a custom domain
added in the dashboard survives later deploys.

| Secret | Required | Notes |
| --- | --- | --- |
| `APNS_KEY_ID` | yes | Key ID of the APNs auth key |
| `APNS_TEAM_ID` | yes | Apple Developer team ID |
| `APNS_BUNDLE_ID` | yes | Sent as `apns-topic`; must match the app |
| `APNS_PRIVATE_KEY` | yes | Contents of the `.p8` |
| `APNS_ENV` | no | Environment tried first: `production` (default) or `sandbox`. A `BadDeviceToken` is retried once on the other, so TestFlight and development-signed builds both work |

Rate limits (`PER_IP` 60/min, `PER_TOKEN` 10/min) are Cloudflare Rate Limiting
bindings in `wrangler.jsonc`, keyed on the `CF-Connecting-IP` the edge sets.
Workers logs stay off, so nothing about a request is kept.

APNs accepts HTTP/2 only. Cloudflare's edge makes that connection for the
Worker, which `wrangler dev` can't reproduce, so pushes only reach Apple from a
deployed Worker. `bun test` covers everything up to the APNs request.

## API

```
POST /push
{ "token": "<64-hex>", "ciphertext": "<base64>", "collapseId": "<id>" }

200 {"ok":true}          delivered
410 {"error":"unregistered"}  app uninstalled — the CALLER prunes its own record
403 {"error":"untrusted_peer"}  didn't come through Cloudflare's edge
429 {"error":"rate_limited"}
503 upstream busy, retry
```

`GET /health` → `{"ok":true,"signable":true}` while the key signs, `503` otherwise.

A request may carry `body` (cleartext) **or** `ciphertext`, never both — sending
both would mean the caller leaked the content the encryption exists to protect,
so the schema rejects it.

## Pointing a Tether server at it

Release binaries have the official relay stamped in at build time (see
`apps/server/src/pushRelay.ts`) — it is not a user-facing setting,
because only the relay holding the APNs key for the app's signing identity can
deliver to that build. Turning on **Push to my devices** in the host's settings
is all a user does.

Running your own relay therefore means your own Apple team and your own client
build. Point a server at it either at build time:

```sh
TETHER_PUSH_RELAY_URL=https://relay.example.com bun --cwd apps/server run build:binary
```

or at runtime, which wins over whatever was baked in:

```sh
TETHER_PUSH_RELAY_URL=https://relay.example.com tether start
```
