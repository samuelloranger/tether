#!/usr/bin/env bash
# Builds the Linux AppImage and the Velopack update package from a release build of tether-app.
#   packaging/linux/package.sh [version] [--skip-build]
# Output in dist/: Tether-<version>-x86_64.AppImage, and in dist/velopack/ the
# *-full.nupkg and releases.linux.json that installed apps update from.
# Needs vpk 1.2.161 on PATH (dotnet tool install -g vpk --version 1.2.161), or set VPK.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
repo="$(cd "$root/../.." && pwd)"
version=""
build=1
for arg in "$@"; do
  case "$arg" in
    --skip-build) build=0 ;;
    *) version="$arg" ;;
  esac
done
version="${version:-$(sed -n 's/^version = "\(.*\)"$/\1/p' "$root/Cargo.toml" | head -1)}"
vpk="${VPK:-vpk}"
# The pack id names the AppImage's icon and its StartupWMClass, which must equal the
# window's app_id for a launcher to group the window under the entry. It also names the
# update package. Velopack keeps its downloads in /var/tmp/velopack/<id>, never the data folder.
pack_id=tether

if [ "$build" = 1 ]; then
  (cd "$root" && cargo build --release --locked -p tether-app)
fi
release="${CARGO_TARGET_DIR:-$root/target}/release"
[ -x "$release/tether" ] || { echo "no release build at $release/tether" >&2; exit 1; }

dist="$root/dist"
rm -rf "$dist"
pack="$dist/pack"
mkdir -p "$pack/licenses" "$dist/velopack"
install -m 755 "$release/tether" "$pack/tether"
cp "$repo/LICENSE" "$pack/LICENSE.txt"
cp "$release"/licenses/* "$pack/licenses/"

"$vpk" pack --packId "$pack_id" --packVersion "$version" \
  --packDir "$pack" --mainExe tether --packTitle Tether \
  --icon "$here/icons/hicolor/256x256/apps/tether.png" \
  --categories "System;TerminalEmulator" \
  --outputDir "$dist/velopack"

appimage="$dist/Tether-$version-x86_64.AppImage"
mv "$dist/velopack/$pack_id.AppImage" "$appimage"

# vpk writes the entry itself; fail the build if it stops matching the window's app_id.
check="$(mktemp -d)"
trap 'rm -rf "$check"' EXIT
(cd "$check" && "$appimage" --appimage-extract '*.desktop' >/dev/null)
grep -qx 'StartupWMClass=tether' "$check"/squashfs-root/*.desktop \
  || { echo "the AppImage's desktop entry does not carry StartupWMClass=tether" >&2; exit 1; }

ls -l "$dist" "$dist/velopack"
