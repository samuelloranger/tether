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

Run this on its own host. **Do not** put it beside a Tether server: the relay is
internet-facing, and a Tether server is a remote shell on the machine hosting
it. They should not share an address, a container, or a blast radius.

```sh
export APNS_KEY_ID=XXXXXXXXXX
export APNS_TEAM_ID=XXXXXXXXXX
export APNS_BUNDLE_ID=com.example.yourapp
export APNS_KEY_FILE=/secure/path/AuthKey_XXXXXXXXXX.p8
docker compose up -d --build
```

Put it behind a TLS-terminating reverse proxy; it listens on plain HTTP and
binds to localhost in the compose file for exactly that reason.

| Variable | Required | Notes |
| --- | --- | --- |
| `APNS_KEY_ID` | yes | Key ID of the APNs auth key |
| `APNS_TEAM_ID` | yes | Apple Developer team ID |
| `APNS_BUNDLE_ID` | yes | Sent as `apns-topic`; must match the app |
| `APNS_KEY_PATH` | yes | Path to the `.p8`, mounted read-only |
| `APNS_ENV` | no | `production` (default) or `sandbox` |
| `PORT` | no | Default `8090` |

## API

```
POST /push
{ "token": "<64-hex>", "ciphertext": "<base64>", "collapseId": "<id>" }

200 {"ok":true}          delivered
410 {"error":"unregistered"}  app uninstalled — the CALLER prunes its own record
429 {"error":"rate_limited"}
503 upstream busy, retry
```

`GET /health` → `{"ok":true}`.

A request may carry `body` (cleartext) **or** `ciphertext`, never both — sending
both would mean the caller leaked the content the encryption exists to protect,
so the schema rejects it.

## Pointing a Tether server at it

Release binaries have the official relay stamped in at build time (see
`apps/server/src/server/pushRelay.ts`) — it is not a user-facing setting,
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
