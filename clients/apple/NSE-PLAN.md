# Notification Service Extension plan

Deferred: needs a new Xcode target (`TetherNotificationService`) and a physical device. Port from `apps/mobile/ios-nse/NotificationService.swift`.

## What it does

APNs payloads from the relay (`apps/relay/src/payload.ts`) look like:

```json
{
  "aps": { "alert": { "title": "Tether", "body": "New activity" }, "mutable-content": 1, "sound": "default" },
  "e": "<base64>"
}
```

`e` is AES-256-GCM ciphertext from `apps/server/src/server/pushCrypto.ts`:

- Wire: `base64(nonce[12] ‖ ciphertext ‖ tag[16])`
- Key: 32 raw bytes, stored as base64 under Keychain account `tether_push_secret` (service `dev.tether.app`), written by `PushRegistrar` with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
- Plaintext JSON: `{ "title": string, "body": string, "link"?: "tether://session/…?host=…" }`

The NSE must:

1. Read `userInfo["e"]`, load the shared Keychain secret, decrypt with CryptoKit `AES.GCM` (split tag from ciphertext — WebCrypto appends the 16-byte tag).
2. Set `content.title` / `content.body` from the JSON; write `content.userInfo["link"]` so `NotificationTapRouter` can deep-link on tap.
3. On any failure, pass through the generic relay alert (reveals nothing).

## Xcode setup (later)

- New App Extension target, `mutable-content` capable, same Team / App Group / **shared keychain access group** as `TetherIOS` (NSE has its own bundle id; without the shared group it cannot read `tether_push_secret`).
- Entitlements: keychain-access-groups matching the app (already on `TetherIOS.entitlements`).
- Prefer moving decrypt into `tether-ffi` later; until then copy the CryptoKit path from the RN NSE.
