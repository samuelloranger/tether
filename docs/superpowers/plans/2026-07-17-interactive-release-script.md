# Interactive Release Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create an interactive Bash release script that bumps versions across the monorepo, runs lints/formatting, commits and pushes to main, and publishes a new release tag via the GitHub CLI.

**Architecture:** A standalone Bash shell script (`scripts/release.sh`) supporting both command-line flags (`--patch`, `--minor`, `--major`, or explicit semver) and an interactive menu. It uses `jq` to edit JSON files, `sed` to edit Cargo.toml, `cargo check` to regenerate Cargo.lock, and `gh release` to publish the release on GitHub. It includes a `--dry-run` flag for safe local verification.

**Tech Stack:** Bash, jq, git, cargo, gh CLI, bun

## Global Constraints
- Target version must match SemVer format: `^[0-9]+\.[0-9]+\.[0-9]+$`.
- All modifications must preserve JSON file formatting (via jq).
- Must run lint checks (`bun lint`) and formatting checks (`bun format`) before committing.
- Must verify a clean git working directory prior to modifying files (unless `--dry-run` or `--force` is used).

---

### Task 1: Scaffolding, CLI Flags, Interactive Menu, and Dry Run

**Files:**
- Create: `scripts/release.sh`

**Interfaces:**
- Consumes: None (starting from scratch)
- Produces: `scripts/release.sh` shell script with `--dry-run` capability, SemVer calculations, and file modification routines.

- [ ] **Step 1: Write the base script skeleton with argument parsing and dry-run flag**

Create `scripts/release.sh` with the following content:
```bash
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
```

- [ ] **Step 2: Add git clean checks, version resolution, and interactive menu**

Append the following logic to `scripts/release.sh`:
```bash
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
```

- [ ] **Step 3: Add file-modification logic for JSON and Cargo files**

Append the following logic to `scripts/release.sh`:
```bash
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
```

- [ ] **Step 4: Make script executable, make sure it has permissions, and test Task 1 using --dry-run**

Run:
```bash
chmod +x scripts/release.sh
./scripts/release.sh --dry-run --patch
```
Expected output:
Shows current version, Target version to release (calculated as patch bump), and `[dry-run] Would update...` messages.

- [ ] **Step 5: Commit scaffolding**

```bash
git add scripts/release.sh
git commit -m "feat: add release script version bumper scaffolding"
```

---

### Task 2: Validation, Git Commit/Push, and GitHub Release

**Files:**
- Modify: `scripts/release.sh`

**Interfaces:**
- Consumes: `scripts/release.sh` version bump logic.
- Produces: Completed `scripts/release.sh` supporting full git committing, branch pushing, and GitHub release creation.

- [ ] **Step 1: Append Validation, Commit/Push and GitHub Release logic**

Append the following logic to the end of `scripts/release.sh`:
```bash
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
```

- [ ] **Step 2: Test complete script in --dry-run mode**

Run:
```bash
./scripts/release.sh --dry-run --patch
```
Expected output:
Outputs the full dry-run plan containing git commit/push simulations and `gh release create` simulation.

- [ ] **Step 3: Run dry-run in interactive mode**

Run:
```bash
./scripts/release.sh --dry-run
```
Expected behavior:
Interactive prompt should appear. Selecting option `1` (or any other) should print the corresponding target version and complete the dry run successfully.

- [ ] **Step 4: Commit completed script**

```bash
git add scripts/release.sh
git commit -m "feat: complete interactive release script"
```
