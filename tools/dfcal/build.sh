#!/bin/sh
# Builds the calendar helper as a .app bundle.
#
# A bundle rather than a plain binary, and this is not stylistic. macOS attributes
# a calendar-access request to the *responsible process*, so a bare CLI spawned by
# the server inherits whatever launched the server — a terminal, an editor, launchd —
# and is refused outright when that process carries no calendar usage description.
# The refusal is silent: the request returns false with no error and the
# authorisation status never leaves "not determined". Running the Mach-O inside a
# bundle directly fails the same way; only launching it *as an app* gives it an
# identity of its own. Hence `open`, and hence the plist.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
app="$here/build/Daily Focus Calendar.app"

[ "$(uname -s)" = "Darwin" ] || { echo "dfcal is macOS-only; nothing to build" >&2; exit 0; }
command -v swiftc >/dev/null 2>&1 || { echo "swiftc not found — install the Xcode command line tools" >&2; exit 1; }

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$here/Info.plist" "$app/Contents/Info.plist"
swiftc -O "$here/main.swift" -o "$app/Contents/MacOS/dfcal"

# Ad-hoc signing is enough for TCC to keep a grant against this bundle id, but the
# grant is keyed to the code as well: rebuilding changes the hash, and macOS may
# ask again. That is a prompt nobody is watching when the server runs headless, so
# a rebuild is worth doing while you are at the keyboard.
codesign --force --sign - "$app" >/dev/null

echo "built $app"
