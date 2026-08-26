#!/usr/bin/env bash
# Fails when the prebuilt TetherFFI.xcframework is older than the Rust sources
# it was built from.
#
# TetherKit links tether-ffi as a SwiftPM `.binaryTarget`, so xcodebuild uses
# whatever binary is already on disk. A change under crates/ therefore compiles,
# passes `cargo test`, builds the app — and is absent from the app, with the
# symptom unchanged. That reads as "my fix didn't work", which is the most
# expensive way to be wrong. Run this before an app build so the mistake is loud.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
XCF="$ROOT/clients/apple/TetherKit/Frameworks/TetherFFI.xcframework"

if [[ ! -d "$XCF" ]]; then
  echo "error: $XCF does not exist. Run scripts/build-xcframework.sh." >&2
  exit 1
fi

# The newest source file anywhere in the workspace crates, by mtime.
newest="$(find "$ROOT/crates" -name '*.rs' -o -name 'Cargo.toml' -o -name 'Cargo.lock' \
  | xargs -r stat -f '%m %N' 2>/dev/null || find "$ROOT/crates" \
  \( -name '*.rs' -o -name 'Cargo.toml' -o -name 'Cargo.lock' \) -printf '%T@ %p\n')"
newest_line="$(printf '%s\n' "$newest" | sort -rn | head -1)"
newest_epoch="${newest_line%% *}"
newest_epoch="${newest_epoch%%.*}"
newest_path="${newest_line#* }"

xcf_epoch="$(stat -f '%m' "$XCF" 2>/dev/null || stat -c '%Y' "$XCF")"

if (( newest_epoch > xcf_epoch )); then
  echo "error: TetherFFI.xcframework is stale." >&2
  echo "  newer source: $newest_path" >&2
  echo "  the app would link the OLD core and your change would be invisible." >&2
  echo "  fix: ./scripts/build-xcframework.sh" >&2
  exit 1
fi

echo "TetherFFI.xcframework is newer than crates/ — ok"
