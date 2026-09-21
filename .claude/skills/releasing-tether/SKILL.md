---
name: releasing-tether
description: Use when cutting, publishing, or rolling back a tether release — bumping the version, running scripts/release.sh, diagnosing a failed or stuck Release builds run, or a push rejected as diverged during a release.
---

# Releasing Tether

## Overview

Tether v5 ships one artifact: the native iOS app. One command cuts a release: `scripts/release.sh --patch|--minor|--major`. It bumps the version (root `package.json` + the Xcode `project.pbxproj`), gates on CI, pushes, and pushes the tag `vX.Y.Z`. The tag starts `Release builds`, which opens a **draft** release, builds + signs the iOS archive, uploads it to TestFlight, and publishes the release only if the iOS job succeeds.

**Core invariant: a release becomes public only after the build succeeds.** A failed build leaves the previous release as `latest`, not a broken one.

> iOS iteration does NOT go through here. To test a change, build + install to the device (see `tether-ios-headless-device-install`). A release is for TestFlight distribution — cut one only when actually distributing.

## The Procedure

```bash
./scripts/release.sh --patch # or --minor / --major
gh run watch $(gh run list --workflow 'Release builds' --limit 1 --json databaseId -q '.[0].databaseId')
```

`release.sh` fetches and rebases onto `origin/$BRANCH` before the bump commit, so a divergent remote does not reject the push. Publication is automatic once the `ios` job passes. Do nothing else.

## Quick Reference

| Need | Command |
|---|---|
| Preview without changing anything | `./scripts/release.sh --dry-run --patch` |
| Check what publish is waiting on | `gh run view --log-failed` |
| Inspect the pending draft | `gh release view vX.Y.Z` |
| Roll back a bad published release | `gh release edit vX.Y.Z --prerelease` |
| Abandon a release that can't be fixed | `gh release delete vX.Y.Z --cleanup-tag` |

## Non-Negotiables

**Never trigger the workflow from a `release` event.** GitHub does not run workflows for draft releases — only `published` fires, which is too late to gate on. CI cannot be triggered *by* a draft; it has to *create* one. Hence the tag-push trigger.

**Never create the release by hand.** The `draft` job owns it. A release you create yourself skips the gate.

**Never `--force` past the CI gate to save time.** `--force` is for a genuinely broken CI run, not an impatient one.

**A tag existing is not a release existing.** The `/releases/latest` API never sees a tag with no published release — that's why pushing the tag up front is safe. Don't "fix" a stuck release by publishing manually.

## When the Build Fails

The release stays a draft — no emergency. Fix forward:

1. `gh run view --log-failed` to find the failure.
2. Transient (flaky runner, fetch): re-run the workflow — the `draft` job reuses the existing draft.
3. Otherwise commit the fix to `main`, let CI go green, then `gh release delete vX.Y.Z --cleanup-tag`.
4. Release the **next** patch version. Re-running at the same version fails: the bump produces no diff and `git commit` aborts.

## Known Landmines

| Symptom | Cause |
|---|---|
| Push rejected, "remote has diverged" | Something landed on origin since your last pull. `release.sh` rebases onto `origin/$BRANCH` before the bump; if you still see it, fetch/rebase manually and re-run. |
| Interactive prompt errors out | No TTY (agent shell, CI). Pass `--patch`/`--minor`/`--major` or an explicit version. |
| Release aborts on formatting | `bun format` touched real source. Commit that separately; a release commit may only contain the version files. |
| iOS archive fails on NSE signing | Manual signing needs `IOS_NSE_PROVISIONING_PROFILE_BASE64` for `com.samuelloranger.tether-mobile.TetherNotificationService` as well as the app profile. |

## Version Files (bumped by the script)

`package.json` (the source of truth the script reads the current version from) and `clients/apple/Tether.xcodeproj/project.pbxproj`.
