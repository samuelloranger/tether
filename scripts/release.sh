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

# Detect current version
CURRENT_VERSION=$(jq -r .version apps/mobile/package.json)
echo "Current version: $CURRENT_VERSION"

# Parse SemVer parts
IFS='.' read -r major minor patch <<< "$CURRENT_VERSION"

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

# Update Cargo.toml
if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] Would update Cargo.toml to version $TARGET_VERSION"
else
  sed -i -E 's/^version = "[^"]*"/version = "'"$TARGET_VERSION"'"/' apps/mobile/src-tauri/Cargo.toml
  echo "Updated apps/mobile/src-tauri/Cargo.toml"
fi

# Regenerate Cargo.lock
if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] Would run cargo check to update Cargo.lock"
else
  echo "Regenerating Cargo.lock..."
  cargo check --manifest-path apps/mobile/src-tauri/Cargo.toml > /dev/null 2>&1
  echo "Updated apps/mobile/src-tauri/Cargo.lock"
fi

# Validation
echo "Running validation checks (lint & format)..."
if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] Would run: bun lint && bun format"
else
  bun lint
  bun format
fi

# Git Ops
BRANCH=$(git branch --show-current)
echo "Preparing Git commit on branch '$BRANCH'..."

if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] Would run: git add ... && git commit -m 'release: v$TARGET_VERSION'"
  echo "[dry-run] Would run: git push origin $BRANCH"
  echo "[dry-run] Would run: gh release create v$TARGET_VERSION --generate-notes"
else
  # Stage the modified files
  git add package.json \
          apps/server/package.json \
          apps/mobile/package.json \
          apps/mobile/app.json \
          apps/mobile/src-tauri/tauri.conf.json \
          apps/mobile/src-tauri/Cargo.toml \
          apps/mobile/src-tauri/Cargo.lock

  git commit -m "release: v$TARGET_VERSION"
  echo "Pushing changes to origin/$BRANCH..."
  git push origin "$BRANCH"

  echo "Creating GitHub Release..."
  if ! gh release create "v$TARGET_VERSION" --generate-notes; then
    echo "Warning: Release creation failed. Check your gh CLI authorization or permissions." >&2
  else
    echo "Successfully created release v$TARGET_VERSION"
  fi
fi

echo "Release process completed successfully!"
