# Desktop signing & auto-update

The desktop CI (`.github/workflows/desktop.yml`) signs release artifacts and
generates the auto-updater feed **only when the matching repository secrets are
present**. Missing secrets → the build still succeeds, just unsigned / without an
update feed. All secrets live in **repo → Settings → Secrets and variables →
Actions** (encrypted; never exposed to fork PRs — safe in a public repo).

## Secrets

### Auto-updater (required for in-app updates)

| Secret | What it is |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | minisign private key that signs update bundles. Generated with `bun --cwd apps/mobile run tauri signer generate`. The matching **public** key is committed in `tauri.conf.json` → `plugins.updater.pubkey`. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | password for that private key. |

When present, `tauri-action` signs each bundle and uploads `latest.json` to the
release; the app's launch check reads it and offers the update.

> **Back up the private key offline.** The public key is baked into every shipped
> app. If the private key is lost you can no longer publish updates that existing
> installs will accept — you'd have to ship a new build with a new public key,
> breaking auto-update for everyone on an older version.

### macOS Developer ID (optional — clears Gatekeeper)

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the "Developer ID Application" cert exported as `.p12` (`base64 -i cert.p12`). |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password. |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)` (`security find-identity -v -p codesigning`). |
| `APPLE_ID` | Apple developer account email. |
| `APPLE_PASSWORD` | an **app-specific** password (appleid.apple.com → App-Specific Passwords), not the account password. |
| `APPLE_TEAM_ID` | 10-character Team ID (developer.apple.com → Membership). |

Requires an Apple Developer Program membership ($99/yr). Without these, macOS
builds are unsigned and users open them via right-click → **Open** once.

### Windows

Not wired yet. Windows signing needs a separate approach (Azure Trusted Signing,
or a `.pfx` + `certificateThumbprint` in `tauri.conf.json`). Until then the
`.msi`/`.exe` are unsigned and SmartScreen shows an "unknown publisher" prompt
(users click **More info → Run anyway**).

## Notes

- Linux (`.deb`/`.rpm`/`.AppImage`) needs no signing.
- The webview CSP is intentionally `null` — this shell only loads the local
  bundled frontend, and a strict CSP breaks react-native-web's runtime style
  injection under webkit2gtk. See the note in `src-tauri/src/main.rs`.
