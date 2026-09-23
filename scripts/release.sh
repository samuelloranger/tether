#!/usr/bin/env bash
set -euo pipefail

for cmd in jq git bun gh; do
  if ! command -v "$cmd" &> /dev/null; then
    echo "Error: $cmd is required but not installed." >&2
    exit 1
  fi
done

DRY_RUN=false
FORCE=false
BUMP_TYPE=""
TARGET_VERSION=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --force)
      FORCE=true
      shift
      ;;
    --patch|--minor|--major)
      BUMP_TYPE="${1#--}"
      shift
      ;;
    -*)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
    *)
      if [ -n "$TARGET_VERSION" ]; then
        echo "Error: Multiple versions specified." >&2
        exit 1
      fi
      TARGET_VERSION="${1#v}" # Strip leading v if any
      shift
      ;;
  esac
done

if [ "$FORCE" = false ] && [ "$DRY_RUN" = false ]; then
  if ! git diff-index --quiet HEAD --; then
    echo "Error: Working directory has uncommitted changes. Stash or commit them, or use --force/--dry-run." >&2
    exit 1
  fi
fi

BRANCH=$(git branch --show-current)
if [ -z "$BRANCH" ]; then
  echo "Error: detached HEAD — check out a branch before releasing." >&2
  exit 1
fi

# Rebase before the bump commit: a remote push since our last pull would reject `git push`,
# and rebasing after the bump risks conflicts in the version files.
if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] Would run: git fetch origin $BRANCH && git rebase origin/$BRANCH"
else
  echo "Syncing with origin/$BRANCH before release..."
  git fetch origin "$BRANCH"
  if ! git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
    echo "Error: origin/$BRANCH not found after fetch." >&2
    exit 1
  fi
  if ! git rebase "origin/$BRANCH"; then
    echo "Error: rebase onto origin/$BRANCH failed. Resolve and re-run." >&2
    exit 1
  fi
fi

# Backstop: must outlast a cold CI run, whose iOS job builds tether-ffi for three targets first.
CI_WAIT_SECONDS=${CI_WAIT_SECONDS:-3600}
CI_POLL_SECONDS=${CI_POLL_SECONDS:-20}
# CI only runs on pushes to main and PRs; other branches never get a run, so fail fast.
CI_APPEAR_SECONDS=${CI_APPEAR_SECONDS:-300}

# Latest CI run for one commit as "status|conclusion|url". Empty when GitHub has
# not created the run yet, which is normal for the first seconds after a push.
ci_run_for() {
  gh run list --commit "$1" --workflow CI --limit 1 --json status,conclusion,url \
    -q '.[0] // empty | "\(.status)|\(.conclusion // "none")|\(.url)"' 2>/dev/null || true
}

# Block until that run concludes. 0 = green, 1 = red, timed out, or never appeared.
wait_for_ci() {
  local sha=$1
  local deadline=$(( $(date +%s) + CI_WAIT_SECONDS ))
  local appear_by=$(( $(date +%s) + CI_APPEAR_SECONDS ))
  local run status conclusion url reported=""
  while :; do
    run=$(ci_run_for "$sha")
    if [ -z "$run" ] && [ "$(date +%s)" -ge "$appear_by" ]; then
      echo "Error: no CI run exists for $sha after ${CI_APPEAR_SECONDS}s." >&2
      echo "       CI runs on pushes to main and on pull requests. Releasing from" >&2
      echo "       '${BRANCH:-this branch}' may never produce one — open a PR, dispatch the CI" >&2
      echo "       workflow for this commit, or re-run with --force." >&2
      return 1
    fi
    if [ -n "$run" ]; then
      IFS='|' read -r status conclusion url <<< "$run"
      if [ "$status" = "completed" ]; then
        if [ "$conclusion" = "success" ]; then
          echo "CI is green on $sha: $url"
          return 0
        fi
        echo "Error: CI concluded '$conclusion' on $sha: $url" >&2
        return 1
      fi
      if [ "$status" != "$reported" ]; then
        echo "  CI is $status: $url"
        reported=$status
      fi
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "Error: CI on $sha did not finish within ${CI_WAIT_SECONDS}s" >&2
      echo "       (last status: ${status:-no run found})." >&2
      return 1
    fi
    sleep "$CI_POLL_SECONDS"
  done
}

# Fast fail on red CI, after the rebase so the run belongs to this tree. The tagged
# commit does not exist yet; it is gated separately below.
if [ "$DRY_RUN" = false ]; then
  HEAD_SHA=$(git rev-parse HEAD)
  echo "Checking CI status for $HEAD_SHA..."
  CI_CONCLUSION=$(gh run list --commit "$HEAD_SHA" --workflow CI --limit 1 \
    --json conclusion -q '.[0].conclusion' 2>/dev/null || true)
  if [ "$CI_CONCLUSION" != "success" ]; then
    echo "Error: CI is not green on HEAD ($HEAD_SHA): ${CI_CONCLUSION:-no run found}." >&2
    echo "Push the commit and wait for CI, or re-run with --force to override." >&2
    [ "$FORCE" = false ] && exit 1
    echo "Warning: --force set, releasing over a non-green CI run." >&2
  fi
fi

CURRENT_VERSION=$(jq -r .version package.json)
echo "Current version: $CURRENT_VERSION"

IFS='.' read -r major minor patch <<< "$CURRENT_VERSION"

if [ -z "$BUMP_TYPE" ] && [ -z "$TARGET_VERSION" ] && [ ! -t 0 ]; then
  echo "Error: no bump specified and stdin is not a TTY (the interactive prompt" >&2
  echo "cannot run here). Pass --patch, --minor, --major, or an explicit version." >&2
  exit 1
fi

if [ -z "$BUMP_TYPE" ] && [ -z "$TARGET_VERSION" ]; then
  NEXT_PATCH="$major.$minor.$((patch + 1))"
  NEXT_MINOR="$major.$((minor + 1)).0"
  NEXT_MAJOR="$((major + 1)).0.0"

  echo "Select version bump option:"
  select opt in "Patch ($NEXT_PATCH)" "Minor ($NEXT_MINOR)" "Major ($NEXT_MAJOR)" "Custom"; do
    case $REPLY in
      1) TARGET_VERSION="$NEXT_PATCH"; break;;
      2) TARGET_VERSION="$NEXT_MINOR"; break;;
      3) TARGET_VERSION="$NEXT_MAJOR"; break;;
      4)
        read -rp "Enter custom version: " TARGET_VERSION
        TARGET_VERSION="${TARGET_VERSION#v}"
        break
        ;;
      *) echo "Invalid option $REPLY";;
    esac
  done
elif [ -n "$BUMP_TYPE" ]; then
  case $BUMP_TYPE in
    patch) TARGET_VERSION="$major.$minor.$((patch + 1))";;
    minor) TARGET_VERSION="$major.$((minor + 1)).0";;
    major) TARGET_VERSION="$((major + 1)).0.0";;
  esac
fi

if [[ ! "$TARGET_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: Target version '$TARGET_VERSION' does not match SemVer pattern." >&2
  exit 1
fi

echo "Target version to release: v$TARGET_VERSION"
if [ "$DRY_RUN" = true ]; then
  echo "--- DRY RUN MODE ---"
fi

echo "Updating file versions..."

update_json() {
  local path=$1
  local filter=$2
  if [ "$DRY_RUN" = true ]; then
    echo "[dry-run] Would update JSON $path to $TARGET_VERSION"
  else
    jq --arg v "$TARGET_VERSION" "$filter" "$path" > "${path}.tmp" && mv "${path}.tmp" "$path"
    echo "Updated $path"
  fi
}

update_json "package.json" ".version = \$v"

if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] Would update Xcode to version $TARGET_VERSION"
else
  # CI overrides this for its upload, but local builds and TestFlight show the committed number.
  sed -i -E 's/MARKETING_VERSION = [^;]*;/MARKETING_VERSION = '"$TARGET_VERSION"';/g' \
    clients/apple/Tether.xcodeproj/project.pbxproj
  echo "Updated clients/apple/Tether.xcodeproj/project.pbxproj"
fi

# The only files a release may modify; anything else dirty means `bun format` touched real
# source, which must be its own commit.
VERSION_FILES=(
  package.json
  clients/apple/Tether.xcodeproj/project.pbxproj
)

echo "Running validation checks (lint & format)..."
if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] Would run: bun lint && bun format"
else
  bun lint
  # `bun format` mutates: re-stage our files after it (it normalizes jq's JSON), then require
  # the rest of the tree clean so a source reformat is never left behind unstaged.
  git add "${VERSION_FILES[@]}"
  bun format
  git add "${VERSION_FILES[@]}"
  if ! git diff --quiet; then
    echo "Error: formatting modified files outside the version bump:" >&2
    git diff --name-only >&2
    echo "Commit those separately, then re-run the release." >&2
    exit 1
  fi
fi

echo "Preparing Git commit on branch '$BRANCH'..."

if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] Would run: git add ... && git commit -m 'release: v$TARGET_VERSION'"
  echo "[dry-run] Would run: git push origin $BRANCH"
  echo "[dry-run] Would wait for CI to go green on the release commit"
  echo "[dry-run] Would run: git tag -a v$TARGET_VERSION && git push origin v$TARGET_VERSION"
else
  git add "${VERSION_FILES[@]}"

  git commit -m "release: v$TARGET_VERSION"
  echo "Pushing changes to origin/$BRANCH..."
  git push origin "$BRANCH"

  # The gate above ran on this commit's parent, and release.yml depends on no CI run, so wait
  # for CI on the bump commit itself before the tag starts publishing.
  if [ "$FORCE" = true ]; then
    echo "Warning: --force set, tagging without waiting for CI on the release commit."
  else
    RELEASE_SHA=$(git rev-parse HEAD)
    echo "Waiting for CI on the release commit $RELEASE_SHA (up to $((CI_WAIT_SECONDS / 60))m)..."
    if ! wait_for_ci "$RELEASE_SHA"; then
      echo >&2
      echo "Not tagging v$TARGET_VERSION. The version bump is already pushed to" >&2
      echo "$BRANCH, so nothing user-facing exists yet: no tag, no draft, no" >&2
      echo "release. Fix the cause and re-run with the same version once CI is" >&2
      echo "green, or re-run with --force to tag over the run." >&2
      exit 1
    fi
  fi

  # The tag starts release.yml, which publishes only after every artifact lands, so a
  # failed build never becomes `releases/latest` (GitHub runs no workflow for drafts).
  echo "Tagging v$TARGET_VERSION..."
  git tag -a "v$TARGET_VERSION" -m "v$TARGET_VERSION"
  if ! git push origin "v$TARGET_VERSION"; then
    echo "Error: tag push failed. The version bump is already pushed; delete the" >&2
    echo "local tag ('git tag -d v$TARGET_VERSION'), fix the cause, and re-run." >&2
    exit 1
  fi
  echo "Pushed tag v$TARGET_VERSION"
fi

echo "Release process completed successfully!"
if [ "$DRY_RUN" = false ]; then
  echo
  echo "Tag v$TARGET_VERSION pushed. Builds are running now."
  echo "A draft release is opened, filled, and published automatically once every"
  echo "artifact is attached. Nothing is user-visible until then."
  echo "  Watch:   gh run watch \$(gh run list --workflow 'Release builds' --limit 1 --json databaseId -q '.[0].databaseId')"
  echo "  Inspect: gh release view v$TARGET_VERSION"
fi
