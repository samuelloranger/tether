---
name: releasing-tether
description: Use when cutting, publishing, or rolling back a tether release — bumping the version, running scripts/release.sh, diagnosing a failed or stuck Release builds run, a release that published with missing assets, or a push rejected as diverged during a release.
---

# Releasing Tether

## Overview

One command cuts a release: `scripts/release.sh --patch|--minor|--major`. It bumps 7 version files, gates on CI, pushes, and creates a **draft** GitHub release. CI then builds every artifact and only publishes the release if all of them succeed.

**Core invariant: a release becomes public only after every artifact is built.** `install.sh` and `tether update` resolve the GitHub `/releases/latest` API, which excludes drafts. So a failed build leaves users on the previous good release instead of a broken "latest". v2.0.0 published before builds ran, shipped with every desktop bundle broken, and needed an emergency v2.0.1.

## The Procedure

```bash
git pull --rebase            # bot commits altstore.json to main after each release
./scripts/release.sh --patch # or --minor / --major
gh run watch $(gh run list --workflow 'Release builds' --limit 1 --json databaseId -q '.[0].databaseId')
```

Publication is automatic once `desktop`, `ios`, `android`, and `server` all pass. Do nothing else.

## Quick Reference

| Need | Command |
|---|---|
| Preview without changing anything | `./scripts/release.sh --dry-run --patch` |
| Check what publish is waiting on | `gh run view --log-failed` |
| Inspect the pending draft | `gh release view vX.Y.Z` |
| Roll back a bad published release | `gh release edit vX.Y.Z --prerelease` |
| Abandon a draft that can't be fixed | `gh release delete vX.Y.Z` |

`--prerelease` is the rollback: the `/releases/latest` API skips prereleases, so `latest` falls back to the previous stable release and installs recover in ~seconds. Do that first, diagnose second.

## Non-Negotiables

**Never `gh release create` without `--draft`.** Publishing before builds finish is precisely the v2.0.0 failure. The workflow triggers on `release: created`, so a draft still builds everything.

**Never add `published` to the workflow's trigger types.** The `publish` job publishes; listening for that event too makes the workflow re-trigger itself.

**Never `--force` past the CI gate to save time.** The gate exists because `release.sh` validates less than CI does — CI also runs server tests, mobile tests, and `build:web`. `build:web` is the check that would have caught v2.0.0. `--force` is for a genuinely broken CI run, not an impatient one.

**A draft release has no git tag.** The tag is created at publish, from the commit `--target` pinned. So inside build jobs `github.ref_name` is the branch, not `vX.Y.Z` — every job reads the version from the workflow-level `TAG` env (`github.event.release.tag_name`). If you add a job that needs the version, use `$TAG`. Using `github.ref_name` bakes `TETHER_VERSION="main"` into the server binary.

## When a Build Leg Fails

The release stays a draft — users are unaffected, so there is no emergency. Fix forward:

1. `gh run view --log-failed` to find the failing leg.
2. Commit the fix to `main`, let CI go green.
3. `gh release delete vX.Y.Z` (removes the draft; no tag exists yet, so nothing to clean up).
4. Re-run `./scripts/release.sh` at the **same** version — pass it explicitly: `./scripts/release.sh 2.0.4`.

Do not hand-upload the missing asset and publish manually. That reintroduces the untested-artifact hole the draft gate closes.

## Known Landmines

| Symptom | Cause |
|---|---|
| Push rejected, "remote has diverged" | The `altstore` job commits `altstore.json` to `main` after every release. `git pull --rebase` before releasing. |
| Interactive prompt errors out | No TTY (agent shell, CI). Pass `--patch`/`--minor`/`--major` or an explicit version — the script refuses rather than hanging. |
| Release aborts on formatting | `bun format` touched real source. Commit that separately; a release commit may only contain the 7 version files. |
| iOS build fails on Xcode | Expo is pinned to 57.0.7 with an `expo-modules-jsi@57.0.3` patch. Never bump Expo as part of a release. |
| Sessions die instantly after install | Unrelated to release — Bun < 1.3.14 has no `proc.terminal`. |

The Android APK is signed with the **public** React Native debug keystore (see the TODO in `release.yml`). It provides no authenticity and cannot be trusted for in-place updates. Don't present it as a signed build.

## Version Files (all bumped by the script)

`package.json`, `apps/server/package.json`, `apps/mobile/package.json`, `apps/mobile/app.json`, `apps/mobile/src-tauri/tauri.conf.json`, `apps/mobile/src-tauri/Cargo.toml`, `apps/mobile/src-tauri/Cargo.lock`

`apps/mobile/package.json` is the source of truth the script reads the current version from.
