#!/bin/sh
# Builds the menu bar app: macos/build/Daily Focus.app, a zip of it, and the disk
# image people download, which shows the app beside a link to Applications.
#
#   sh macos/build.sh [--server DIR] [--test]
#
# --server DIR  copies a built server package (dist/cli.js, public/, prompts/,
#               schema/, package.json) into the app. Without it the app has no
#               dashboard of its own, and runs the one DAILY_FOCUS_APP_SERVER_ENTRY
#               names, which is how it is developed against a checkout.
# --test        runs the app's self-test after building.
#
# The app carries its own Node.js, at the version in macos/node-version, downloaded
# from nodejs.org on the first build and checked against its published checksums.
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

rm -rf "$app" "$zip"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$app/Contents/Helpers"
cp "$here/Info.plist" "$app/Contents/Info.plist"

# The app's version is the package's, which the Release workflow stamps into
# package.json from the commits (scripts/release.ts); a checkout's is a placeholder.
version=$(plutil -extract version raw -o - "${server:-$repo}/package.json")
plutil -replace CFBundleShortVersionString -string "$version" "$app/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$version" "$app/Contents/Info.plist"

# Apple silicon only, as is everything in the app: Intel Macs stopped at macOS 26,
# and carrying Node for both would double the download for them.
swiftc -O -target arm64-apple-macos13.5 -o "$app/Contents/MacOS/Daily Focus" "$here"/DailyFocus/*.swift

sh "$repo/tools/dfcal/build.sh" --app "$app/Contents/Helpers"

# The app's icon and the disk image's background, drawn by code in this repo.
swiftc -O -o "$build/artwork" "$here/Artwork/main.swift"
"$build/artwork" "$build/art"
cp "$build/art/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"

# The Node.js the dashboard runs on, carried in the app so that nothing has to be
# installed first: the official Apple silicon release, at the version in
# macos/node-version. The download is checked against the checksums nodejs.org
# publishes, fetched over HTTPS from the same place, and kept in macos/build/ so a
# rebuild doesn't fetch it again. It is signed again below with this app's
# identity, since the official build carries get-task-allow, a debugging
# entitlement notarisation refuses.
node_version=$(tr -d '[:space:]' < "$here/node-version")
node_cache="$build/node-v$node_version"
mkdir -p "$node_cache"
if [ ! -s "$node_cache/SHASUMS256.txt" ]; then
  curl -fsSL "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o "$node_cache/SHASUMS256.txt"
fi
name="node-v$node_version-darwin-arm64"
if [ ! -s "$node_cache/$name.tar.gz" ]; then
  echo "downloading Node.js $node_version"
  curl -fsSL "https://nodejs.org/dist/v$node_version/$name.tar.gz" -o "$node_cache/$name.tar.gz"
fi
expected=$(awk -v file="$name.tar.gz" '$2 == file { print $1 }' "$node_cache/SHASUMS256.txt")
actual=$(shasum -a 256 "$node_cache/$name.tar.gz" | awk '{ print $1 }')
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  rm -f "$node_cache/$name.tar.gz"
  echo "$name.tar.gz doesn't match the checksum nodejs.org publishes; refusing to bundle it" >&2
  exit 1
fi
tar -xzf "$node_cache/$name.tar.gz" -C "$node_cache" "$name/bin/node" "$name/LICENSE"
cp "$node_cache/$name/bin/node" "$app/Contents/Helpers/node"
# Node's licence, and those of what it bundles, go wherever Node does.
cp "$node_cache/$name/LICENSE" "$app/Contents/Resources/Node.js LICENSE"
echo "bundled Node.js $node_version"

if [ -n "$server" ]; then
  ditto "$server" "$app/Contents/Resources/server"
  echo "copied the server from $server"
else
  echo "no --server: the app runs whatever DAILY_FOCUS_APP_SERVER_ENTRY names"
fi

# The identity. Matched by hash, since a renewed certificate leaves two with one name.
identity=${DAILY_FOCUS_SIGN_IDENTITY:-}
identity_name=$identity
# A certificate named by its hash is still checked by its name below, for whether
# it can notarise, so look the name up.
if [ -n "$identity" ] && [ "$identity" != "-" ]; then
  named=$(security find-identity -v -p codesigning 2>/dev/null | grep -F "$identity" | head -n 1 | sed 's/^[^"]*"\(.*\)"$/\1/' || true)
  [ -n "$named" ] && identity_name=$named
fi
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
# V8 compiles JavaScript to machine code as it runs, which the hardened runtime
# allows only with these two entitlements.
sign "$app/Contents/Helpers/node" "$here/Node.entitlements"
sign "$app" "$here/DailyFocus.entitlements"
codesign --verify --deep --strict "$app"
echo "signature verified"

if [ "$test" = yes ]; then
  "$app/Contents/MacOS/Daily Focus" --self-test
fi

# Notarisation: the app first, so the ticket can be stapled into the app itself and
# it opens offline from wherever it is copied; then the disk image it ships in.
notarise() {
  # notarytool can exit 0 for a submission Apple rejected, so the verdict is read
  # from what it prints.
  result=$(xcrun notarytool submit "$1" --keychain-profile "$DAILY_FOCUS_NOTARY_PROFILE" --wait 2>&1) || true
  printf '%s\n' "$result"
  if ! printf '%s\n' "$result" | grep -q "status: Accepted"; then
    echo "notarisation failed; \`xcrun notarytool log <id> --keychain-profile $DAILY_FOCUS_NOTARY_PROFILE\` says why" >&2
    exit 1
  fi
}

notarising=no
if [ -n "${DAILY_FOCUS_NOTARY_PROFILE:-}" ]; then
  case "$identity_name" in
    "Developer ID Application:"*) notarising=yes ;;
    *)
      echo "can't notarise: the app is signed by $identity_name, and notarisation needs a Developer ID Application certificate" >&2
      exit 1
      ;;
  esac
  ditto -c -k --keepParent "$app" "$zip"
  notarise "$zip"
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

# The disk image people download: the app beside a link to Applications, laid out
# by dmgbuild (see macos/dmg-settings.py). dmgbuild is a Python package, installed
# at a pinned version into a virtual environment under macos/build/, and it needs
# Python 3.10 or newer. Without one the image is skipped and the zip still stands.
dmg="$build/Daily Focus.dmg"
rm -f "$dmg"
if python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
  venv="$build/dmgbuild"
  if [ ! -x "$venv/bin/dmgbuild" ]; then
    python3 -m venv "$venv"
    "$venv/bin/pip" install --quiet --disable-pip-version-check dmgbuild==1.6.7 ds-store==1.3.3 mac-alias==2.2.3
  fi
  "$venv/bin/dmgbuild" -s "$here/dmg-settings.py" \
    -D app="$app" -D background="$build/art/dmg-background.tiff" -D icon="$build/art/AppIcon.icns" \
    "Daily Focus" "$dmg" >/dev/null
  if [ "$identity" = "-" ]; then
    codesign --force --sign - "$dmg"
  else
    codesign --force --timestamp --sign "$identity" "$dmg"
  fi
  if [ "$notarising" = yes ]; then
    notarise "$dmg"
    xcrun stapler staple "$dmg"
  fi
  echo "and $dmg"
else
  echo "no disk image: making one needs Python 3.10 or newer, for dmgbuild" >&2
fi
