# Desktop signing & auto-update

The `desktop` job in `.github/workflows/release.yml` builds `apps/desktop` and
signs its update artifacts **only when the matching repository secrets are
present**. All secrets live in **repo → Settings → Secrets and variables →
Actions** (encrypted; never exposed to fork PRs — safe in a public repo).

`apps/desktop` sets `bundle.createUpdaterArtifacts: true`, which is what makes the
bundler emit the `.sig` files `latest.json` is assembled from. It also means a
build **fails** without a signing key — the bundler reports *"A public key has
been found, but no private key"* after bundling. That is deliberate: a release
must never quietly stop producing signatures. For a local build without the key,
use `bun --cwd apps/desktop run tauri:build:unsigned`, which overrides the flag
back off.

## Secrets

### Auto-updater (required for in-app updates)

| Secret | What it is |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | minisign private key that signs update bundles. Generated with `bun --cwd apps/desktop run tauri signer generate`. The matching **public** key is committed in `tauri.conf.json` → `plugins.updater.pubkey`. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | password for that private key. |

When present, `tauri-action` signs each bundle. `latest.json` is **not** written
by the build legs (`includeUpdaterJson: false`): they run in parallel against one
release, and tauri-action maintains that file by read-modify-write, so they raced
and could drop a platform silently. The `publish` job builds it once from the
signed bundles on the release (`scripts/build-updater-manifest.ts`) and refuses to
emit a manifest that is missing a platform, holding the release as a draft
instead. The app's launch check then reads it and offers the update.

The bundler also warns when `TAURI_SIGNING_PRIVATE_KEY` does not match the
`pubkey` committed in `tauri.conf.json` — treat that warning as a failed release,
because installed clients will reject the bundles.

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

- Linux (`.deb`/`.rpm`/`.AppImage`) needs no OS-level signing. It still needs the
  updater key: that signature is what the in-app updater verifies, on every
  platform.
- The bundle identifier stays `cloud.samlo.tether`, inherited from the previous
  desktop client. It names the webview data directory the app migrates host
  profiles out of, and on Windows it is the NSIS install path and uninstall
  registry key — changing it installs a second copy instead of upgrading.
- `apps/desktop` ships a real CSP (see `tauri.conf.json`). The old `null` CSP
  existed because a strict one broke react-native-web's runtime style injection
  under webkit2gtk; that client is gone.
