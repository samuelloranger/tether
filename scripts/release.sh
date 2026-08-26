#!/usr/bin/env bash
set -euo pipefail

# Ensure dependencies are installed
for cmd in jq cargo git bun gh; do
  if ! command -v "$cmd" &> /dev/null; then
    echo "Error: $cmd is required but not installed." >&2
    exit 1
  fi
done

DRY_RUN=false
FORCE=false
BUMP_TYPE=""
TARGET_VERSION=""

# Parse arguments
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

# Verify clean working directory
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

# Sync with origin BEFORE the version-bump commit. Anything that landed on the
# remote since our last pull (historically the altstore bot committing to main;
# now any other push) would make a bare `git push` get rejected as diverged.
# Rebasing after the bump is riskier (conflict in the version files), so do it
# while the tree is still clean.
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

# Require CI to be green on the exact commit we are about to release. release.sh
# used to validate less than CI did (lint+format here vs. lint + server tests +
# mobile tests + build:web there) — and build:web is what broke every desktop
# bundle in v2.0.0. Gating on CI keeps one definition of "good" instead of two
# that drift. Runs after the pre-flight rebase so we gate on the commit we will
# actually tag.
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

# Detect current version
CURRENT_VERSION=$(jq -r .version apps/mobile/package.json)
echo "Current version: $CURRENT_VERSION"

# Parse SemVer parts
IFS='.' read -r major minor patch <<< "$CURRENT_VERSION"

if [ -z "$BUMP_TYPE" ] && [ -z "$TARGET_VERSION" ] && [ ! -t 0 ]; then
  echo "Error: no bump specified and stdin is not a TTY (the interactive prompt" >&2
  echo "cannot run here). Pass --patch, --minor, --major, or an explicit version." >&2
  exit 1
fi

if [ -z "$BUMP_TYPE" ] && [ -z "$TARGET_VERSION" ]; then
  # Interactive mode
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

# Validate target version format
if [[ ! "$TARGET_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: Target version '$TARGET_VERSION' does not match SemVer pattern." >&2
  exit 1
fi

echo "Target version to release: v$TARGET_VERSION"
if [ "$DRY_RUN" = true ]; then
  echo "--- DRY RUN MODE ---"
fi

echo "Updating file versions..."

# Helper function to update JSON version
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
update_json "apps/server/package.json" ".version = \$v"
update_json "apps/mobile/package.json" ".version = \$v"
update_json "apps/mobile/src-tauri/tauri.conf.json" ".version = \$v"
update_json "apps/mobile/app.json" ".expo.version = \$v"
# apps/desktop is the shipping desktop client (release.yml's `desktop` job). Its
# version is what the updater compares against latest.json, so leaving it behind
# makes every install think an update is permanently available: the manifest
# advertises the new tag, the downloaded bundle reports the old one, and the
# prompt returns on the next check forever.
update_json "apps/desktop/package.json" ".version = \$v"
update_json "apps/desktop/src-tauri/tauri.conf.json" ".version = \$v"

# Update Cargo.toml
if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] Would update Cargo.toml to version $TARGET_VERSION"
else
  sed -i -E 's/^version = "[^"]*"/version = "'"$TARGET_VERSION"'"/' apps/mobile/src-tauri/Cargo.toml
  echo "Updated apps/mobile/src-tauri/Cargo.toml"
  sed -i -E '0,/^version = "[^"]*"/s//version = "'"$TARGET_VERSION"'"/' apps/desktop/src-tauri/Cargo.toml
  echo "Updated apps/desktop/src-tauri/Cargo.toml"
  # The native iOS client is what release.yml's `ios` job archives, and its
  # marketing version lives in the Xcode project. CI overrides it on the command
  # line for the build it uploads, but a project committed at an older number is
  # what anyone building locally gets — and it is the number TestFlight shows.
  sed -i -E 's/MARKETING_VERSION = [^;]*;/MARKETING_VERSION = '"$TARGET_VERSION"';/g' \
    clients/apple/Tether.xcodeproj/project.pbxproj
  echo "Updated clients/apple/Tether.xcodeproj/project.pbxproj"
fi

# Regenerate Cargo.lock
if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] Would run cargo check to update Cargo.lock"
else
  echo "Regenerating Cargo.lock..."
  cargo check --manifest-path apps/mobile/src-tauri/Cargo.toml > /dev/null 2>&1
  echo "Updated apps/mobile/src-tauri/Cargo.lock"
  cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml > /dev/null 2>&1
  echo "Updated apps/desktop/src-tauri/Cargo.lock"
fi

# The complete set of files a release is allowed to modify. Anything else showing
# up dirty below means `bun format` reformatted real source, which must be its own
# commit — not silently swept into (or, worse, dropped from) the release.
VERSION_FILES=(
  package.json
  apps/server/package.json
  apps/mobile/package.json
  apps/mobile/app.json
  apps/mobile/src-tauri/tauri.conf.json
  apps/mobile/src-tauri/Cargo.toml
  apps/mobile/src-tauri/Cargo.lock
  apps/desktop/package.json
  apps/desktop/src-tauri/tauri.conf.json
  apps/desktop/src-tauri/Cargo.toml
  apps/desktop/src-tauri/Cargo.lock
  clients/apple/Tether.xcodeproj/project.pbxproj
)

# Validation
echo "Running validation checks (lint & format)..."
if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] Would run: bun lint && bun format"
else
  bun lint
  # `bun format` is `biome check --write` — it mutates. Stage the files we own,
  # run it, re-stage them (it normalizes jq's JSON output), then require the tree
  # to be otherwise clean. Previously a reformat of any source file landed in the
  # working tree, was never staged (the add list is version files only), and got
  # left behind by the push.
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

# Git Ops
echo "Preparing Git commit on branch '$BRANCH'..."

if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] Would run: git add ... && git commit -m 'release: v$TARGET_VERSION'"
  echo "[dry-run] Would run: git push origin $BRANCH"
  echo "[dry-run] Would run: git tag -a v$TARGET_VERSION && git push origin v$TARGET_VERSION"
else
  git add "${VERSION_FILES[@]}"

  git commit -m "release: v$TARGET_VERSION"
  echo "Pushing changes to origin/$BRANCH..."
  git push origin "$BRANCH"

  # Pushing the tag is what starts release.yml. That workflow opens a DRAFT
  # release, attaches every artifact to it, and only then publishes — so a failed
  # build never becomes the public `releases/latest` that install.sh and
  # `tether update` resolve stable asset names from (the exact way v2.0.0 shipped
  # a release with no working desktop bundles).
  #
  # The tag, unlike a release, has to exist up front: GitHub does not run
  # workflows for draft releases, so CI cannot be triggered by a draft — it has to
  # create one. A bare tag is invisible to both clients, which resolve the releases
  # API, so nothing user-facing exists until the publish job runs.
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
