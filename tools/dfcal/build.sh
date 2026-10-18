#!/bin/sh
# Builds the calendar helper as a .app bundle.
#
#   sh tools/dfcal/build.sh                    # into tools/dfcal/build/, for this Mac
#   sh tools/dfcal/build.sh --release OUT_DIR  # into OUT_DIR/, for other Macs
#
# A bundle rather than a plain binary, and this is not stylistic. macOS attributes
# a calendar-access request to the *responsible process*, so a bare CLI spawned by
# the server inherits whatever launched the server — a terminal, an editor, launchd —
# and is refused outright when that process carries no calendar usage description.
# The refusal is silent: the request returns false with no error and the
# authorisation status never leaves "not determined". Running the Mach-O inside a
# bundle directly fails the same way; only launching it *as an app* gives it an
# identity of its own. Hence `open`, and hence the plist.
#
# `--release` builds the copy a release ships, in the menu bar app and in the npm
# package, which runs on Macs the app doesn't: Intel ones, and macOS 11, the oldest
# Node.js 22 runs on. So both architectures, from macOS 11. The release signs it
# again with its own identity. The default stays a build for this Mac, which is all
# a checkout needs.
set -eu

here=$(cd "$(dirname "$0")" && pwd)

for_release=no
if [ "${1:-}" = "--release" ]; then
  for_release=yes
  shift
fi
out=${1:-"$here/build"}

[ "$(uname -s)" = "Darwin" ] || { echo "dfcal is macOS-only; nothing to build" >&2; exit 0; }
command -v swiftc >/dev/null 2>&1 || { echo "swiftc not found — install the Xcode command line tools" >&2; exit 1; }

mkdir -p "$out"
app="$(cd "$out" && pwd)/Daily Focus Calendar.app"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$here/Info.plist" "$app/Contents/Info.plist"
if [ "$for_release" = yes ]; then
  slices=$(mktemp -d)
  swiftc -O -target arm64-apple-macos11 "$here/main.swift" -o "$slices/arm64"
  swiftc -O -target x86_64-apple-macos11 "$here/main.swift" -o "$slices/x86_64"
  lipo -create -output "$app/Contents/MacOS/dfcal" "$slices/arm64" "$slices/x86_64"
  rm -rf "$slices"
else
  swiftc -O "$here/main.swift" -o "$app/Contents/MacOS/dfcal"
fi

# Ad-hoc signing is enough for TCC to keep a grant against this bundle id, but the
# grant is keyed to the code as well: rebuilding changes the hash, and macOS may
# ask again. That is a prompt nobody is watching when the server runs headless, so
# a rebuild is worth doing while you are at the keyboard. A release signs its copy
# again with a Developer ID, which macOS keeps the grant against across versions.
codesign --force --sign - "$app" >/dev/null

echo "built $app"
