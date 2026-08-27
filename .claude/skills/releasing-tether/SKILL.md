---
name: releasing-tether
description: Use when cutting, publishing, or rolling back a tether release — bumping the version, running scripts/release.sh, diagnosing a failed or stuck Release builds run, a release that published with missing assets, or a push rejected as diverged during a release.
---

# Releasing Tether

## Overview

One command cuts a release: `scripts/release.sh --patch|--minor|--major`. It bumps 7 version files, gates on CI, pushes, and pushes the tag `vX.Y.Z`. The tag starts `Release builds`, which opens a **draft** release, attaches every artifact to it, and publishes only if all four artifact jobs succeed.

**Core invariant: a release becomes public only after every artifact is built.** `install.sh` and `tether update` resolve the GitHub `/releases/latest` API, which excludes drafts. So a failed build leaves users on the previous good release instead of a broken "latest". v2.0.0 published before builds ran, shipped with every desktop bundle broken, and needed an emergency v2.0.1.

## The Procedure

```bash
./scripts/release.sh --patch # or --minor / --major
gh run watch $(gh run list --workflow 'Release builds' --limit 1 --json databaseId -q '.[0].databaseId')
```

`release.sh` fetches and rebases onto `origin/$BRANCH` before the bump commit, so a divergent remote does not reject the push. Publication is automatic once `desktop`, `ios`, `android`, and `server` all pass. Do nothing else.

## Quick Reference

| Need | Command |
|---|---|
| Preview without changing anything | `./scripts/release.sh --dry-run --patch` |
| Check what publish is waiting on | `gh run view --log-failed` |
| Inspect the pending draft | `gh release view vX.Y.Z` |
| Roll back a bad published release | `gh release edit vX.Y.Z --prerelease` |
| Abandon a release that can't be fixed | `gh release delete vX.Y.Z --cleanup-tag` |

`--prerelease` is the rollback: the `/releases/latest` API skips prereleases, so `latest` falls back to the previous stable release and installs recover in ~seconds. Do that first, diagnose second.

## Non-Negotiables

**Never trigger the workflow from a `release` event.** GitHub does not run workflows for draft releases at all — `created`, `edited`, and `deleted` are all suppressed for drafts, and only `published` fires, which is too late to gate on. This was tried and silently did nothing: the draft was created, no run started. CI cannot be triggered *by* a draft; it has to *create* one. Hence the tag-push trigger.

**Never create the release by hand.** The `draft` job owns it. A release you create yourself skips the gate, which is the entire point of the pipeline.

**Never `--force` past the CI gate to save time.** The gate exists because `release.sh` validates less than CI does — CI also runs server tests, mobile tests, and `build:web`. `build:web` is the check that would have caught v2.0.0. `--force` is for a genuinely broken CI run, not an impatient one.

**A tag existing is not a release existing.** `install.sh` and `tether update` both resolve the releases API, which never sees a tag with no published release — that's why pushing the tag up front is safe. Don't "fix" a stuck release by publishing manually.

## When a Build Leg Fails

The release stays a draft — users are unaffected, so there is no emergency. Fix forward:

1. `gh run view --log-failed` to find the failing leg.
2. If the fix is outside the build (a flaky runner, a transient fetch), just re-run the workflow — the `draft` job reuses the existing draft instead of erroring on the duplicate tag.
3. Otherwise commit the fix to `main` and let CI go green, then `gh release delete vX.Y.Z --cleanup-tag` to remove both the draft and the tag.
4. Release the **next** patch version. Re-running `release.sh` at the same version fails: the version files already hold it, so the bump produces no diff and `git commit` aborts.

Do not hand-upload the missing asset and publish manually. That reintroduces the untested-artifact hole the gate closes.

## Known Landmines

| Symptom | Cause |
|---|---|
| Push rejected, "remote has diverged" | Something landed on origin since your last pull. `release.sh` rebases onto `origin/$BRANCH` before the bump; if you still see this, fetch/rebase manually and re-run. (The old altstore-bot-to-main race is gone — the manifest now publishes to samlo.cloud.) |
| Interactive prompt errors out | No TTY (agent shell, CI). Pass `--patch`/`--minor`/`--major` or an explicit version — the script refuses rather than hanging. |
| Release aborts on formatting | `bun format` touched real source. Commit that separately; a release commit may only contain the version files listed below. |
| iOS archive fails on NSE signing | Manual signing needs `IOS_NSE_PROVISIONING_PROFILE_BASE64` for `com.samuelloranger.tether-mobile.TetherNotificationService` as well as the app profile. |
| Sessions die instantly after install | Unrelated to release — Bun < 1.3.14 has no `proc.terminal`. |

## Version Files (all bumped by the script)

`package.json`, `apps/server/package.json`, `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/Cargo.lock`, `clients/apple/Tether.xcodeproj/project.pbxproj`

Root `package.json` is the source of truth the script reads the current version from.
