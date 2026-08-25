#!/usr/bin/env bash
# Builds tether-ffi for iOS device + simulator, generates Swift bindings, and
# assembles an XCFramework. Requires macOS with Xcode — see the Darwin guard below.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: scripts/build-xcframework.sh must run on macOS with the Apple SDK." >&2
  echo "  This script cross-compiles for aarch64-apple-ios, aarch64-apple-ios-sim," >&2
  echo "  and x86_64-apple-ios, then runs xcodebuild -create-xcframework." >&2
  echo "  It cannot run on Linux or other non-Darwin hosts." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$ROOT/crates/tether-ffi"
MANIFEST="$CRATE/Cargo.toml"
PROFILE="${PROFILE:-release}"
BUILD_DIR="$ROOT/build/ios-ffi"
OUT_XCF="$ROOT/clients/apple/xcframework/TetherFFI.xcframework"
OUT_SWIFT="$ROOT/clients/apple/xcframework/swift"
OUT_HEADERS="$BUILD_DIR/headers"

LIB_NAME="tether_ffi"
DEVICE_TARGET="aarch64-apple-ios"
SIM_ARM_TARGET="aarch64-apple-ios-sim"
SIM_X86_TARGET="x86_64-apple-ios"
SIM_FAT_DIR="$BUILD_DIR/simulator"

echo "==> Installing Rust iOS targets (if missing)"
rustup target add "$DEVICE_TARGET" "$SIM_ARM_TARGET" "$SIM_X86_TARGET"

echo "==> Building $LIB_NAME for iOS device ($DEVICE_TARGET, $PROFILE)"
cargo build --manifest-path "$MANIFEST" --"$PROFILE" --target "$DEVICE_TARGET"

echo "==> Building $LIB_NAME for iOS simulator ($SIM_ARM_TARGET, $PROFILE)"
cargo build --manifest-path "$MANIFEST" --"$PROFILE" --target "$SIM_ARM_TARGET"

echo "==> Building $LIB_NAME for iOS simulator ($SIM_X86_TARGET, $PROFILE)"
cargo build --manifest-path "$MANIFEST" --"$PROFILE" --target "$SIM_X86_TARGET"

DEVICE_LIB="$CRATE/target/$DEVICE_TARGET/$PROFILE/lib${LIB_NAME}.a"
SIM_ARM_LIB="$CRATE/target/$SIM_ARM_TARGET/$PROFILE/lib${LIB_NAME}.a"
SIM_X86_LIB="$CRATE/target/$SIM_X86_TARGET/$PROFILE/lib${LIB_NAME}.a"

for lib in "$DEVICE_LIB" "$SIM_ARM_LIB" "$SIM_X86_LIB"; do
  if [[ ! -f "$lib" ]]; then
    echo "error: expected static library not found: $lib" >&2
    exit 1
  fi
done

mkdir -p "$SIM_FAT_DIR"
SIM_FAT_LIB="$SIM_FAT_DIR/lib${LIB_NAME}.a"
echo "==> Creating fat simulator library"
lipo -create "$SIM_ARM_LIB" "$SIM_X86_LIB" -output "$SIM_FAT_LIB"

mkdir -p "$OUT_SWIFT" "$OUT_HEADERS"
echo "==> Generating Swift bindings (uniffi 0.28.3)"
cargo run --manifest-path "$MANIFEST" --"$PROFILE" --bin uniffi-bindgen -- \
  generate \
  --library "$DEVICE_LIB" \
  --language swift \
  --out-dir "$OUT_SWIFT"

# UniFFI emits tether_ffiFFI.h and tether_ffi.modulemap alongside the Swift sources.
if [[ ! -f "$OUT_SWIFT/${LIB_NAME}FFI.h" ]]; then
  echo "error: UniFFI header not found at $OUT_SWIFT/${LIB_NAME}FFI.h" >&2
  exit 1
fi
cp "$OUT_SWIFT/${LIB_NAME}FFI.h" "$OUT_HEADERS/"
if [[ -f "$OUT_SWIFT/${LIB_NAME}.modulemap" ]]; then
  cp "$OUT_SWIFT/${LIB_NAME}.modulemap" "$OUT_HEADERS/module.modulemap"
fi

rm -rf "$OUT_XCF"
mkdir -p "$(dirname "$OUT_XCF")"
echo "==> Assembling XCFramework at $OUT_XCF"
xcodebuild -create-xcframework \
  -library "$DEVICE_LIB" \
  -headers "$OUT_HEADERS" \
  -library "$SIM_FAT_LIB" \
  -headers "$OUT_HEADERS" \
  -output "$OUT_XCF"

echo "==> Done"
echo "  XCFramework: $OUT_XCF"
echo "  Swift bindings: $OUT_SWIFT"
