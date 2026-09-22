# Installing Tether on an iPhone via `macbuild`

Direct wireless install of a development build onto a paired physical iPhone,
driven entirely over SSH from Linux. No TestFlight, no version bump, no Xcode GUI.

TestFlight is for *distribution*. This is the iteration loop.

## Why it needs a manual signing step

Headless `xcodebuild` cannot see the Xcode GUI account store, so
`CODE_SIGN_STYLE=Automatic` always fails with `No Account for Team "<TEAM>"`.
The way around it is to build **unsigned**, mint development provisioning
profiles through the App Store Connect REST API, and re-sign the bundle by hand.

Two profiles are needed — one for the app, one for the notification-service
extension — because each bundle id gets its own.

## Prerequisites (one-time, already in place)

| Thing | Where |
|---|---|
| Mac build host | ssh host `macbuild`, Xcode installed, repo checked out at `~/sites/tether` |
| iPhone | paired to the Mac (wireless pairing is enough) and registered as a device in App Store Connect |
| App Store Connect API key | `~/.appstoreconnect/private_keys/AuthKey_<KID>.p8` on the Mac, mode 600 |
| Apple Development certificate | in the Mac's **login keychain** with its private key |
| Provisioning profiles | one per bundle id, `IOS_APP_DEVELOPMENT`, including this device + this certificate |

Check the certificate is there and note its SHA-1:

```bash
ssh -T -q macbuild 'security find-identity -v -p codesigning'
```

Pick the `Apple Development: …` line **without** `CSSMERR_TP_CERT_REVOKED`.

Find the phone's UDID:

```bash
ssh -T -q macbuild 'xcrun devicectl list devices' # the row with Reality = physical
```

## The loop

### 1. Get the source onto the Mac

`macbuild`'s checkout is frequently on a **different branch with its own WIP** —
do not `git checkout` / `reset` / force-push into it.

```bash
# safe: file-level sync, never --delete
rsync -a --relative <changed files> macbuild:/Users/samuelloranger/sites/tether/
```

If you do a full sync, `--delete` must exclude both generated paths or the next
build dies with a misleading `Could not resolve package dependencies`:

```
--exclude 'clients/apple/TetherKit/Frameworks' \
--exclude 'clients/apple/TetherKit/Sources/TetherFFIBindings'
```

### 2. Rebuild the Rust XCFramework — only if `crates/` changed

`TetherFFI` is a prebuilt `.binaryTarget`. A Rust change that skips this step
compiles, tests green, and is **silently absent from the app**.

```bash
ssh -T -q macbuild 'cd ~/sites/tether && bash scripts/build-xcframework.sh'
```

### 3. Archive unsigned

```bash
ssh -T -q macbuild 'cd ~/sites/tether/clients/apple && \
  rm -rf /tmp/tether-dev.xcarchive && \
  xcodebuild archive \
    -project Tether.xcodeproj \
    -scheme TetherIOS \
    -destination "generic/platform=iOS" \
    -archivePath /tmp/tether-dev.xcarchive \
    CODE_SIGNING_ALLOWED=NO'
```

Do **not** use `xcodebuild -exportArchive` afterwards — it reads a stale profile
index and will not see the minted profiles.

Result layout:

```
/tmp/tether-dev.xcarchive/Products/Applications/TetherIOS.app
  └── PlugIns/TetherNotificationService.appex
```

There is no `Frameworks/` directory — TetherKit links statically, so only the
`.appex` and the `.app` get signed.

### 4. Verify the profiles before using them

**A profile's filename can lie about its bundle id.** Signing still succeeds and
`codesign --verify` passes; it only blows up at install time with
`MismatchedApplicationIdentifierEntitlement`. Always read the real value:

```bash
ssh -T -q macbuild '
for p in /tmp/*.mobileprovision; do
  security cms -D -i "$p" > /tmp/x.plist
  printf "%s -> " "$p"
  /usr/libexec/PlistBuddy -c "Print :Entitlements:application-identifier" /tmp/x.plist
  /usr/libexec/PlistBuddy -c "Print :ExpirationDate" /tmp/x.plist
done'
```

You want one profile ending in `…tether-mobile` (the app) and one ending in
`…tether-mobile.TetherNotificationService` (the NSE).

If they are missing or expired, mint new ones — see *Minting profiles* below.

### 5. Sign and install — **from inside the GUI login session**

`codesign` over a plain SSH session fails with `errSecInternalComponent`: a
headless session cannot reach the login keychain's private keys. The script must
run under the logged-in GUI session via `launchctl asuser`.

Write the script on the Mac:

```bash
ssh -T -q macbuild 'cat > /tmp/sign-install.sh' <<'SCRIPT'
#!/bin/bash
set -euo pipefail

ARCHIVE=/tmp/tether-dev.xcarchive
APP="$ARCHIVE/Products/Applications/TetherIOS.app"
APPEX="$APP/PlugIns/TetherNotificationService.appex"

CERT=<apple-development-cert-sha1>
UDID=<iphone-udid>
PROFILE_APP=<path to the …tether-mobile profile>
PROFILE_NSE=<path to the …TetherNotificationService profile>

sign() {
  local target="$1" profile="$2"
  cp "$profile" "$target/embedded.mobileprovision"
  security cms -D -i "$profile" > /tmp/pp.plist
  /usr/libexec/PlistBuddy -x -c "Print :Entitlements" /tmp/pp.plist > /tmp/ent.plist
  codesign --force --sign "$CERT" \
    --entitlements /tmp/ent.plist --generate-entitlement-der "$target"
}

# inside-out: the extension first, then the app that contains it
sign "$APPEX" "$PROFILE_NSE"
sign "$APP"   "$PROFILE_APP"

codesign --verify --deep --strict "$APP" && echo "codesign OK"
xcrun devicectl device install app --device "$UDID" "$APP"
SCRIPT
```

Run it in the GUI session (UID 501 is the console user):

```bash
ssh -T -q macbuild 'chmod +x /tmp/sign-install.sh && \
  sudo launchctl asuser 501 sudo -u samuelloranger bash /tmp/sign-install.sh'
```

`devicectl` prints a warning about running under `sudo` — harmless, it installs.
The app appears on the Home screen within a few seconds. Launch it and test.

## Minting profiles (only when they expire or a new device/bundle id appears)

All through the App Store Connect REST API, authenticated with an ES256 JWT
signed by the `.p8` key. `xcodebuild -allowProvisioningUpdates` is **not** an
alternative — it goes back through the GUI account store.

1. `POST /v1/devices` with the phone's UDID (409 means it is already registered;
   the `GET` filter needs the **dashed** form of the UDID).
2. Match the local keychain certificate to an ASC certificate by **serial
   number** — the SHA-1 above is not the ASC id.
3. `POST /v1/profiles`, `profileType: IOS_APP_DEVELOPMENT`, once per bundle id,
   each referencing the device + the certificate.
4. Base64-decode each response's `profileContent` to a `.mobileprovision` file
   and re-check its `application-identifier` (step 4 above).

Sanity check that the key works at all: a hand-signed JWT against `GET /v1/apps`
should return 200. A 401 `NOT_AUTHORIZED` means the key is revoked or the
Key ID / Issuer ID pair is wrong.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `No Account for Team "…"` | You let the build sign itself. Archive with `CODE_SIGNING_ALLOWED=NO` and re-sign manually. |
| `errSecInternalComponent` from `codesign` | Running over plain SSH. Re-run under `launchctl asuser`. |
| `MismatchedApplicationIdentifierEntitlement` at install | Wrong profile for that bundle — the filename lied. Re-check `application-identifier`. |
| `Could not resolve package dependencies` | `Sources/TetherFFIBindings` was deleted by an `rsync --delete`. Re-run `scripts/build-xcframework.sh`. |
| Rust fix has no effect in the app | Stale XCFramework. Run `scripts/build-xcframework.sh`, then rebuild. |
| `Your account has reached the maximum number of certificates` | Certificate cap. Revoke the API-minted *Apple Development* certs in the developer portal — never the Developer ID ones. |
| Device not listed by `devicectl` | Phone locked, off the same network, or pairing lost. Unlock it and re-check. |

## What this is *not*

Do not cut a TestFlight/App Store release to test a change. `scripts/release.sh`
is for distribution — other devices, testers, shipping. CI signs an App Store
*distribution* identity, which cannot be installed directly on a device anyway.
