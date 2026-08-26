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
# `debug` and `dev` both mean cargo's dev profile, whose output lands in
# target/<triple>/debug. The script used to interpolate PROFILE straight into a
# `--$PROFILE` flag, so PROFILE=debug produced `cargo build --debug`, which cargo
# rejects outright — the knob only ever worked for its own default.
PROFILE="${PROFILE:-release}"
case "$PROFILE" in
  release) CARGO_PROFILE=(--profile release); TARGET_SUBDIR=release ;;
  debug|dev) CARGO_PROFILE=(--profile dev); TARGET_SUBDIR=debug ;;
  *)
    echo "error: PROFILE must be 'release' or 'debug' (got '$PROFILE')." >&2
    exit 1
    ;;
esac
BUILD_DIR="$ROOT/build/ios-ffi"
# SwiftPM refuses a target whose path escapes the package root, so the
# generated framework and bindings are emitted INSIDE TetherKit.
OUT_XCF="$ROOT/clients/apple/TetherKit/Frameworks/TetherFFI.xcframework"
OUT_SWIFT="$ROOT/clients/apple/TetherKit/Sources/TetherFFIBindings"
OUT_HEADERS="$BUILD_DIR/headers"

UNIFFI_VERSION="0.28.3"
LIB_NAME="tether_ffi"
DEVICE_TARGET="aarch64-apple-ios"
SIM_ARM_TARGET="aarch64-apple-ios-sim"
SIM_X86_TARGET="x86_64-apple-ios"
SIM_FAT_DIR="$BUILD_DIR/simulator"

echo "==> Installing Rust iOS targets (if missing)"
rustup target add "$DEVICE_TARGET" "$SIM_ARM_TARGET" "$SIM_X86_TARGET"

echo "==> Building $LIB_NAME for iOS device ($DEVICE_TARGET, $PROFILE)"
cargo build --manifest-path "$MANIFEST" "${CARGO_PROFILE[@]}" --target "$DEVICE_TARGET"

echo "==> Building $LIB_NAME for iOS simulator ($SIM_ARM_TARGET, $PROFILE)"
cargo build --manifest-path "$MANIFEST" "${CARGO_PROFILE[@]}" --target "$SIM_ARM_TARGET"

echo "==> Building $LIB_NAME for iOS simulator ($SIM_X86_TARGET, $PROFILE)"
cargo build --manifest-path "$MANIFEST" "${CARGO_PROFILE[@]}" --target "$SIM_X86_TARGET"

DEVICE_LIB="$CRATE/target/$DEVICE_TARGET/$TARGET_SUBDIR/lib${LIB_NAME}.a"
SIM_ARM_LIB="$CRATE/target/$SIM_ARM_TARGET/$TARGET_SUBDIR/lib${LIB_NAME}.a"
SIM_X86_LIB="$CRATE/target/$SIM_X86_TARGET/$TARGET_SUBDIR/lib${LIB_NAME}.a"

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
# uniffi-bindgen's --library mode shells out to `cargo metadata` in the CURRENT
# working directory, and this repo has no workspace manifest at its root — so
# running this from the repo root fails with "error running cargo metadata".
# Run it from inside the crate instead.
(
  cd "$CRATE"
  cargo run --manifest-path "$MANIFEST" "${CARGO_PROFILE[@]}" --bin uniffi-bindgen -- \
    generate \
    --library "$DEVICE_LIB" \
    --language swift \
    --out-dir "$OUT_SWIFT"
)

# UniFFI emits <lib>FFI.h and <lib>FFI.modulemap next to the Swift sources.
#
# BOTH are required. Without the modulemap Clang cannot form the tether_ffiFFI
# module, so the generated Swift's `#if canImport(tether_ffiFFI)` is false, the
# import is skipped, and every C type it needs (RustBuffer, RustCallStatus,
# ForeignBytes) is missing — producing a wall of "cannot find type in scope".
# An earlier version guarded this copy with `if [[ -f ... ]]` and looked for the
# wrong filename, so the miss was a silent no-op. Fail loudly instead.
for required in "${LIB_NAME}FFI.h" "${LIB_NAME}FFI.modulemap"; do
  if [[ ! -f "$OUT_SWIFT/$required" ]]; then
    echo "error: UniFFI did not emit $required in $OUT_SWIFT" >&2
    echo "       (uniffi $UNIFFI_VERSION may have changed its output names)" >&2
    exit 1
  fi
done
cp "$OUT_SWIFT/${LIB_NAME}FFI.h" "$OUT_HEADERS/"
cp "$OUT_SWIFT/${LIB_NAME}FFI.modulemap" "$OUT_HEADERS/module.modulemap"

# The Swift target must contain ONLY Swift. A stray .h/.modulemap in a SwiftPM
# source directory is not a mixed target — it is an error waiting to happen.
rm -f "$OUT_SWIFT/${LIB_NAME}FFI.h" "$OUT_SWIFT/${LIB_NAME}FFI.modulemap"

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
