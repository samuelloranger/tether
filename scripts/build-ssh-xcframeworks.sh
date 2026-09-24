#!/usr/bin/env bash
# Rebuilds the vendored SSH XCFrameworks (libssh2 + OpenSSL libcrypto/libssl)
# in clients/apple/TetherKit/Frameworks/SSH and refreshes the libssh2.h that
# CLibSSH2 compiles against. macOS only: needs Xcode, cmake, curl, git.
#
#   bash scripts/build-ssh-xcframeworks.sh
#   LIBSSH2_REF=libssh2-1.11.2 bash scripts/build-ssh-xcframeworks.sh
set -euo pipefail

LIBSSH2_REF="${LIBSSH2_REF:-2e1717456b8dd4c980e8e48d6dbfec524c2e62d1}"
OPENSSL_VERSION="${OPENSSL_VERSION:-4.0.2}"
OPENSSL_SHA256="${OPENSSL_SHA256:-736b467530f916737b7031310ccb21d8218c6229e61e8e160cd1d3458cd543a8}"
MIN_IOS="${MIN_IOS:-17.0}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$ROOT/clients/apple/TetherKit/Frameworks/SSH}"
HEADER_OUT="${HEADER_OUT:-$ROOT/clients/apple/TetherKit/Sources/CLibSSH2/include}"
WORK="${WORK:-$(mktemp -d -t tether-ssh-build)}"
JOBS="$(sysctl -n hw.ncpu)"

# slice : OpenSSL Configure target : SDK : arch : clang min-version flag
SLICES=(
  "ios-arm64:ios64-xcrun:iphoneos:arm64:-mios-version-min"
  "sim-arm64:iossimulator-arm64-xcrun:iphonesimulator:arm64:-mios-simulator-version-min"
  "sim-x86_64:iossimulator-x86_64-xcrun:iphonesimulator:x86_64:-mios-simulator-version-min"
)

log() { printf '\n==> %s\n' "$*"; }

[[ "$(uname)" == Darwin ]] || { echo "macOS only" >&2; exit 1; }
command -v cmake >/dev/null || { echo "cmake not found" >&2; exit 1; }

mkdir -p "$WORK"
cd "$WORK"

log "OpenSSL $OPENSSL_VERSION"
tarball="openssl-$OPENSSL_VERSION.tar.gz"
[[ -f "$tarball" ]] || curl -fsSL -o "$tarball" \
  "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/$tarball"
echo "$OPENSSL_SHA256  $tarball" | shasum -a 256 -c -

log "libssh2 $LIBSSH2_REF"
if [[ ! -d libssh2 ]]; then
  git init -q libssh2
  git -C libssh2 remote add origin https://github.com/libssh2/libssh2.git
fi
git -C libssh2 fetch -q --depth 1 origin "$LIBSSH2_REF"
git -C libssh2 checkout -q --detach FETCH_HEAD
LIBSSH2_SHA="$(git -C libssh2 rev-parse HEAD)"

for spec in "${SLICES[@]}"; do
  IFS=: read -r slice target sdk arch minflag <<<"$spec"
  prefix="$WORK/prefix/$slice"

  log "OpenSSL $slice ($target)"
  rm -rf "openssl-$slice"
  mkdir "openssl-$slice"
  tar -xzf "$tarball" -C "openssl-$slice" --strip-components 1
  (
    cd "openssl-$slice"
    ./Configure "$target" no-shared no-tests no-apps no-docs \
      "$minflag=$MIN_IOS" --prefix="$prefix" --libdir=lib >/dev/null 2>&1
    make -j"$JOBS" build_libs >/dev/null
    make install_dev >/dev/null 2>&1
  )

  log "libssh2 $slice"
  rm -rf "build-libssh2-$slice"
  cmake -S libssh2 -B "build-libssh2-$slice" \
    -DCMAKE_SYSTEM_NAME=iOS \
    -DCMAKE_OSX_SYSROOT="$sdk" \
    -DCMAKE_OSX_ARCHITECTURES="$arch" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$MIN_IOS" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$prefix" \
    -DCMAKE_FIND_ROOT_PATH="$prefix" \
    -DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=BOTH \
    -DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=BOTH \
    -DCMAKE_FIND_ROOT_PATH_MODE_PACKAGE=BOTH \
    -DCRYPTO_BACKEND=OpenSSL \
    -DOPENSSL_ROOT_DIR="$prefix" \
    -DOPENSSL_USE_STATIC_LIBS=TRUE \
    -DENABLE_ZLIB_COMPRESSION=ON \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_STATIC_LIBS=ON \
    -DBUILD_EXAMPLES=OFF \
    -DBUILD_TESTING=OFF \
    -DLIBSSH2_BUILD_DOCS=OFF \
    >/dev/null
  cmake --build "build-libssh2-$slice" -j"$JOBS" >/dev/null
  cmake --install "build-libssh2-$slice" >/dev/null

  # CLibSSH2 links libz; a silently skipped zlib would drop compression support.
  if [[ "$(nm -u "$prefix/lib/libssh2.a" 2>/dev/null | grep -c '_deflate')" == 0 ]]; then
    echo "libssh2 $slice built without zlib" >&2
    exit 1
  fi
done

log "XCFrameworks"
mkdir -p "$WORK/fat"
for lib in ssh2 crypto ssl; do
  lipo -create \
    "$WORK/prefix/sim-arm64/lib/lib$lib.a" \
    "$WORK/prefix/sim-x86_64/lib/lib$lib.a" \
    -output "$WORK/fat/lib$lib.a"
  rm -rf "$WORK/$lib.xcframework"
  xcodebuild -create-xcframework \
    -library "$WORK/prefix/ios-arm64/lib/lib$lib.a" \
    -library "$WORK/fat/lib$lib.a" \
    -output "$WORK/$lib.xcframework" >/dev/null
done

log "Installing into $OUT"
# Everything is staged and backed up beside its own destination, so every swap is a rename
# on one volume, and rolled back on any failure: a half-replaced set would pair the new
# libssh2 with an old OpenSSL or header.
dirs=()
swapped=()
replaced=0
installed=false
rollback() {
  # Best effort: one failed restore must not stop the others.
  set +e
  # `${a[@]+…}`: bash 3.2 (macOS) treats an empty array as unset under `set -u`.
  for dest in ${swapped[@]+"${swapped[@]}"}; do
    backup_dir="$(dirname "$dest")/.tether-install-backup"
    rm -rf "$dest"
    if [[ -e "$backup_dir/$(basename "$dest")" ]]; then mv "$backup_dir/$(basename "$dest")" "$dest"; fi
  done
  kept=""
  for dir in ${dirs[@]+"${dirs[@]}"}; do
    if [[ "$dir" == */.tether-install-backup ]] && ! rmdir "$dir" 2>/dev/null; then kept="$kept $dir"; fi
    [[ "$dir" == */.tether-install-stage ]] && rm -rf "$dir"
  done
  if [[ -n "$kept" ]]; then
    echo "install failed; originals that could not be restored are in:$kept" >&2
  elif [[ $replaced -eq 0 ]]; then
    echo "install failed; nothing was replaced" >&2
  else
    echo "install failed; restored the previous frameworks and header" >&2
  fi
}
trap '$installed || rollback' EXIT

prepare() { # <destination dir>: fresh stage and backup dirs beside it
  # A backup left by an earlier failed run may hold the only copy of an original.
  if [[ -d "$1/.tether-install-backup" ]] && [[ -n "$(ls -A "$1/.tether-install-backup")" ]]; then
    echo "$1/.tether-install-backup holds files from a failed install; restore or remove them first" >&2
    exit 1
  fi
  rm -rf "$1/.tether-install-stage" "$1/.tether-install-backup"
  mkdir "$1/.tether-install-stage" "$1/.tether-install-backup"
  dirs+=("$1/.tether-install-stage" "$1/.tether-install-backup")
}
prepare "$OUT"
[[ "$HEADER_OUT" -ef "$OUT" ]] || prepare "$HEADER_OUT"

for lib in ssh2 crypto ssl; do
  cp -R "$WORK/$lib.xcframework" "$OUT/.tether-install-stage/"
done
cp "$WORK/prefix/ios-arm64/include/libssh2.h" "$HEADER_OUT/.tether-install-stage/libssh2.h"
cp libssh2/COPYING "$OUT/.tether-install-stage/LICENSE-libssh2"
cp "openssl-ios-arm64/LICENSE.txt" "$OUT/.tether-install-stage/LICENSE-openssl"

for name in ssh2.xcframework crypto.xcframework ssl.xcframework libssh2.h LICENSE-libssh2 LICENSE-openssl; do
  if [[ "$name" == libssh2.h ]]; then dir="$HEADER_OUT"; else dir="$OUT"; fi
  dest="$dir/$name"
  if [[ -e "$dest" ]]; then mv "$dest" "$dir/.tether-install-backup/"; fi
  # Only after the original is safe in the backup: rollback deletes what it lists.
  swapped+=("$dest")
  replaced=$((replaced + 1))
  mv "$dir/.tether-install-stage/$name" "$dest"
done
installed=true
trap - EXIT
for dir in "${dirs[@]}"; do rm -rf "$dir"; done

log "Done"
echo "libssh2  $LIBSSH2_SHA"
echo "OpenSSL  $OPENSSL_VERSION"
echo "min iOS  $MIN_IOS"
echo "Xcode    $(xcodebuild -version | head -1) ($(xcrun --sdk iphoneos --show-sdk-version) SDK)"
echo "cmake    $(cmake --version | head -1)"
