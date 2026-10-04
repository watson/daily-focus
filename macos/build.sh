#!/bin/sh
# Builds the menu bar app: macos/build/Daily Focus.app, and a zip of it beside it.
#
#   sh macos/build.sh [--server DIR] [--test]
#
# --server DIR  copies a built server package (dist/cli.js, public/, prompts/,
#               schema/, package.json) into the app. Without it the app has no
#               dashboard of its own, and runs the one DAILY_FOCUS_APP_SERVER_ENTRY
#               names, which is how it is developed against a checkout.
# --test        runs the app's self-test after building.
#
# Signing uses DAILY_FOCUS_SIGN_IDENTITY when set, else the first Developer ID
# Application identity in the keychain, else the first Apple Development one, else
# an ad-hoc signature. Notarisation happens only when DAILY_FOCUS_NOTARY_PROFILE
# names a `xcrun notarytool store-credentials` profile.
#
# Plain swiftc rather than an Xcode project: the app is a handful of files, and a
# project file is a second description of them that drifts.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
build="$here/build"
app="$build/Daily Focus.app"
zip="$build/Daily Focus.zip"

server=""
test=no
while [ $# -gt 0 ]; do
  case "$1" in
    --server)
      [ $# -ge 2 ] || { echo "--server needs a directory" >&2; exit 64; }
      server=$2
      shift 2
      ;;
    --test)
      test=yes
      shift
      ;;
    *)
      echo "usage: sh macos/build.sh [--server DIR] [--test]" >&2
      exit 64
      ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || { echo "the menu bar app is macOS-only" >&2; exit 1; }
command -v swiftc >/dev/null 2>&1 || { echo "swiftc not found — install the Xcode command line tools" >&2; exit 1; }
if [ -n "$server" ] && [ ! -f "$server/dist/cli.js" ]; then
  echo "$server has no dist/cli.js; --server wants a built server package" >&2
  exit 1
fi

rm -rf "$app" "$zip" "$build/slices"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$app/Contents/Helpers" "$build/slices"
cp "$here/Info.plist" "$app/Contents/Info.plist"

# One slice per architecture, joined into one binary, so the same download runs on
# Apple silicon and Intel.
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos13.0" -o "$build/slices/Daily Focus-$arch" "$here"/DailyFocus/*.swift
done
lipo -create -output "$app/Contents/MacOS/Daily Focus" "$build/slices/Daily Focus-arm64" "$build/slices/Daily Focus-x86_64"
rm -rf "$build/slices"

sh "$repo/tools/dfcal/build.sh" --universal "$app/Contents/Helpers"

if [ -n "$server" ]; then
  ditto "$server" "$app/Contents/Resources/server"
  echo "copied the server from $server"
else
  echo "no --server: the app runs whatever DAILY_FOCUS_APP_SERVER_ENTRY names"
fi

# The identity. Matched by hash, since a renewed certificate leaves two with one name.
identity=${DAILY_FOCUS_SIGN_IDENTITY:-}
identity_name=$identity
if [ -z "$identity" ]; then
  identities=$(security find-identity -v -p codesigning 2>/dev/null || true)
  for kind in "Developer ID Application" "Apple Development"; do
    line=$(printf '%s\n' "$identities" | grep "\"$kind: " | head -n 1 || true)
    if [ -n "$line" ]; then
      identity=$(printf '%s\n' "$line" | awk '{ print $2 }')
      identity_name=$(printf '%s\n' "$line" | sed 's/^[^"]*"\(.*\)"$/\1/')
      break
    fi
  done
fi
if [ -z "$identity" ] || [ "$identity" = "-" ]; then
  identity=-
  identity_name="ad-hoc"
fi
echo "signing as $identity_name"

# Inside out: the helper first, so the app's signature seals a signed helper.
#
# The hardened runtime is what notarisation asks for, and under it a process may
# use only the protected resources its entitlements name. The helper reads
# calendars. The app names more than it uses itself, because macOS holds the app
# responsible for everything it starts: the server, the morning agent's CLI, and
# whatever that CLI runs to read Reminders or Messages. A permission prompt for any
# of them says "Daily Focus", and is refused outright unless the app is entitled.
sign() {
  target=$1
  entitlements=$2
  if [ "$identity" = "-" ]; then
    codesign --force --entitlements "$entitlements" --sign - "$target"
    return
  fi
  if codesign --force --options runtime --timestamp --entitlements "$entitlements" --sign "$identity" "$target" 2>"$build/codesign.log"; then
    rm -f "$build/codesign.log"
    return
  fi
  case "$identity_name" in
    "Apple Development:"*)
      # A development signature is for this Mac only, and doesn't need the
      # timestamp server, which can't be reached offline.
      echo "signing with a timestamp failed; signing without one" >&2
      rm -f "$build/codesign.log"
      codesign --force --options runtime --entitlements "$entitlements" --sign "$identity" "$target"
      ;;
    *)
      cat "$build/codesign.log" >&2
      exit 1
      ;;
  esac
}
sign "$app/Contents/Helpers/Daily Focus Calendar.app" "$here/Calendar.entitlements"
sign "$app" "$here/DailyFocus.entitlements"
codesign --verify --deep --strict "$app"
echo "signature verified"

if [ "$test" = yes ]; then
  "$app/Contents/MacOS/Daily Focus" --self-test
fi

if [ -n "${DAILY_FOCUS_NOTARY_PROFILE:-}" ]; then
  case "$identity_name" in
    "Developer ID Application:"*) ;;
    *)
      echo "can't notarise: the app is signed by $identity_name, and notarisation needs a Developer ID Application certificate" >&2
      exit 1
      ;;
  esac
  ditto -c -k --keepParent "$app" "$zip"
  # notarytool can exit 0 for a submission Apple rejected, so the verdict is read
  # from what it prints.
  result=$(xcrun notarytool submit "$zip" --keychain-profile "$DAILY_FOCUS_NOTARY_PROFILE" --wait 2>&1) || true
  printf '%s\n' "$result"
  if ! printf '%s\n' "$result" | grep -q "status: Accepted"; then
    echo "notarisation failed; \`xcrun notarytool log <id> --keychain-profile $DAILY_FOCUS_NOTARY_PROFILE\` says why" >&2
    exit 1
  fi
  xcrun stapler staple "$app"
  rm -f "$zip"
else
  echo "notarisation skipped: DAILY_FOCUS_NOTARY_PROFILE is not set. It needs a Developer ID Application"
  echo "certificate and credentials saved with \`xcrun notarytool store-credentials\`. Without it, the app"
  echo "opens on this Mac, but Gatekeeper refuses it on others."
fi

ditto -c -k --keepParent "$app" "$zip"
echo "built $app"
echo "and $zip"
