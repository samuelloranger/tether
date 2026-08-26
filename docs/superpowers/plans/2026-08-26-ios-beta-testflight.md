# iOS beta → TestFlight (native Swift client)

Operator runbook for the `scope=testflight` lane in `.github/workflows/beta.yml`.

## Shared app identity

The native Swift app in `clients/apple` now uses the **same** App Store identity as the shipping Expo client:

| | |
|---|---|
| Bundle id | `com.samuelloranger.tether-mobile` |
| ASC app id | `6800525706` ("Tether Terminal") |

Both codebases upload into **one** TestFlight. Testers see native beta builds alongside Expo shipping / release-lane builds in the same app listing. There is no separate ASC record for the rewrite.

## Build-number band: `900000 + run_number`

`release.yml` pins `CURRENT_PROJECT_VERSION` to `${{ github.run_number }}` for the Expo app. `beta.yml` has its **own** independent `run_number` counter that starts low. Copying that counter onto the same ASC record would collide immediately — ASC permanently rejects a duplicate `(version, build)` pair.

The beta lane therefore sets:

```text
CURRENT_PROJECT_VERSION = 900000 + github.run_number
```

That puts every beta build in a `9xxxxx` band that release.yml's counter cannot reach, stays monotonic, and is obvious in ASC as "this came from the beta lane."

`MARKETING_VERSION` defaults to `apps/mobile/app.json` → `.expo.version` (so the beta tracks the shipping version line). Override per dispatch with the `version` input. Neither value is written back into `project.pbxproj` or `app.json`; both are passed as `xcodebuild` build settings.

## How to run

1. GitHub → **Actions** → **Beta (native rewrite)**.
2. **Run workflow**.
3. Branch: the rewrite branch that has this workflow (today: `feat/ios-beta-pipeline` / wherever `beta.yml` lives).
4. **scope** = `testflight`.
5. **version** (optional): leave empty to inherit `apps/mobile/app.json`, or set e.g. `2.8.12`.

`scope=ios` still builds an unsigned simulator binary only. Push events never enter the TestFlight path.

## Secrets (all pre-existing; shared with `release.yml`)

| Secret | Used for |
|---|---|
| `APP_STORE_CONNECT_KEY_P8_BASE64` | ASC API key `.p8` (base64), decoded to `~/.appstoreconnect/private_keys/` |
| `APP_STORE_CONNECT_KEY_ID` | Key id for altool + xcodebuild `-authenticationKeyID` |
| `APP_STORE_CONNECT_ISSUER_ID` | Issuer for altool + xcodebuild `-authenticationKeyIssuerID` |
| `APPLE_TEAM_ID` | `DEVELOPMENT_TEAM` / ExportOptions `teamID` |

No new secrets. Signing mirrors `release.yml`: automatic style + `-allowProvisioningUpdates`.

## Artifacts

On every `scope=testflight` run (including failed uploads), the workflow uploads:

- the `.ipa` under `build/export/`
- `build/TetherIOS.xcarchive`

as workflow artifacts named `beta-ios-testflight-<sha>`.

## RISKS

**(a) Certificate minting.** `-allowProvisioningUpdates` creates signing assets on demand. This Apple account has previously hit the distribution-certificate cap that way. If signing starts failing with a cert-limit error, revoke unused certificates in the Apple Developer portal and re-run.

**(b) Irreversible build numbers.** Every successful (and most attempted) uploads consume a real `(version, build)` on the **live** ASC app record. You cannot undo that. Prefer a deliberate dispatch over "just seeing if it works."

**(c) Internal TestFlight groups.** Creating or changing an **INTERNAL** TestFlight group must be done in the App Store Connect **web UI**. The ASC API silently creates **EXTERNAL** groups instead, which is the wrong kind for private rewrite betas.
