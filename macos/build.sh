#!/bin/sh
# Builds the menu bar app: macos/build/Daily Focus.app, a zip of it,
# Daily-Focus-App.zip, which an app that already runs downloads to replace itself,
# and the disk image people download, which shows the app beside a link to
# Applications.
#
#   sh macos/build.sh [--server DIR] [--test]
#
# --server DIR  copies a built server package (dist/cli.js, public/, prompts/,
#               schema/, package.json) into the app. Without it the app has no
#               dashboard of its own, and runs the one DAILY_FOCUS_APP_SERVER_ENTRY
#               names, which is how it is developed against a checkout. With it,
#               the same package is also signed as a bundle of its own and zipped,
#               Daily-Focus-Dashboard.zip, the update a release offers apps that
#               already have one (see macos/DailyFocus/Updater.swift).
# --test        runs the app's self-test after building.
#
# The app carries its own Node.js, at the version in macos/node-version, downloaded
# from nodejs.org on the first build and checked against its published checksums,
# and the newest GitHub CLI, for a Mac without one, checked against its release's
# checksums and GitHub's signature.
#
# Signing uses DAILY_FOCUS_SIGN_IDENTITY when set, else the first Developer ID
# Application identity in the keychain, else the first Apple Development one, else
# an ad-hoc signature. Notarisation, of the disk image, happens only when
# DAILY_FOCUS_NOTARY_PROFILE names a `xcrun notarytool store-credentials` profile.
#
# Plain swiftc rather than an Xcode project: the app is a handful of files, and a
# project file is a second description of them that drifts.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
build="$here/build"
app="$build/Daily Focus.app"
zip="$build/Daily-Focus-App.zip"

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
# The last commit to change the app, which the Release workflow stamps into the
# package, so the app can tell a newer release whose app changed from one whose
# dashboard did. A checkout's package has none, and its app is never told of one.
app_source=$(plutil -extract daily-focus.appSource raw -o - "${server:-$repo}/package.json" 2>/dev/null || true)
if [ -n "$app_source" ]; then
  plutil -replace DFAppSource -string "$app_source" "$app/Contents/Info.plist"
fi

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
echo "bundled Node.js $node_version"

# The GitHub CLI, for a Mac without one of its own: the dashboard uses this copy
# only when there is no gh on PATH (src/install.ts), and then signs in through it
# from the page, since nobody has it in a terminal. The newest release, looked up
# at every build, Apple silicon only as Node is. The download is checked against
# the checksums its release publishes, and the program against GitHub's own
# Developer ID, whose signature it keeps: unlike Node's build, it carries nothing
# notarisation refuses. It goes in a folder of its own, which the dashboard puts
# on the PATH of the CLIs it runs, so that adds gh and nothing else.
github_team=VEKTX9H2N7
gh_tag=$(curl -fsSI https://github.com/cli/cli/releases/latest 2>/dev/null | awk 'tolower($1) == "location:" { print $2 }' | tr -d '\r' | sed 's#.*/##' || true)
case "$gh_tag" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *)
    # Offline: the newest already downloaded, if there is one.
    gh_tag=$(ls -d "$build"/gh-v* 2>/dev/null | sed 's#.*/gh-##' | sort -V | tail -n 1 || true)
    [ -n "$gh_tag" ] || { echo "couldn't find the newest GitHub CLI release, and none is downloaded" >&2; exit 1; }
    echo "couldn't ask GitHub for its newest CLI release; using $gh_tag, downloaded before" >&2
    ;;
esac
gh_version=${gh_tag#v}
gh_cache="$build/gh-$gh_tag"
gh_name="gh_${gh_version}_macOS_arm64"
mkdir -p "$gh_cache"
if [ ! -s "$gh_cache/$gh_name.zip" ]; then
  echo "downloading the GitHub CLI $gh_version"
  curl -fsSL "https://github.com/cli/cli/releases/download/$gh_tag/gh_${gh_version}_checksums.txt" -o "$gh_cache/checksums.txt"
  curl -fsSL "https://github.com/cli/cli/releases/download/$gh_tag/$gh_name.zip" -o "$gh_cache/$gh_name.zip"
fi
expected=$(awk -v file="$gh_name.zip" '$2 == file { print $1 }' "$gh_cache/checksums.txt")
actual=$(shasum -a 256 "$gh_cache/$gh_name.zip" | awk '{ print $1 }')
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  rm -f "$gh_cache/$gh_name.zip"
  echo "$gh_name.zip doesn't match the checksum its release publishes; refusing to bundle it" >&2
  exit 1
fi
rm -rf "$gh_cache/$gh_name"
ditto -x -k "$gh_cache/$gh_name.zip" "$gh_cache"
if ! codesign --verify --strict -R "=anchor apple generic and certificate leaf[subject.OU] = \"$github_team\"" "$gh_cache/$gh_name/bin/gh"; then
  echo "$gh_name/bin/gh isn't signed by GitHub; refusing to bundle it" >&2
  exit 1
fi
mkdir -p "$app/Contents/Helpers/GitHub CLI"
cp "$gh_cache/$gh_name/bin/gh" "$app/Contents/Helpers/GitHub CLI/gh"
echo "bundled the GitHub CLI $gh_version"

dashboard="$build/Daily Focus Dashboard.bundle"
dashboard_zip="$build/Daily-Focus-Dashboard.zip"
rm -rf "$dashboard" "$dashboard_zip"
if [ -n "$server" ]; then
  ditto "$server" "$app/Contents/Resources/server"
  echo "copied the server from $server"
  # The dashboard on its own, laid out as it is in the app, for an app that
  # downloads it as an update.
  mkdir -p "$dashboard/Contents/Resources"
  cp "$here/Dashboard.plist" "$dashboard/Contents/Info.plist"
  plutil -replace CFBundleShortVersionString -string "$version" "$dashboard/Contents/Info.plist"
  plutil -replace CFBundleVersion -string "$version" "$dashboard/Contents/Info.plist"
  ditto "$server" "$dashboard/Contents/Resources/server"
else
  echo "no --server: the app runs whatever DAILY_FOCUS_APP_SERVER_ENTRY names"
fi

# The licences of what the app carries that others wrote, in one file, which the
# app shows in a window of its own (Acknowledgements in its menu). Node's covers
# what Node bundles. gh's release has only its own; those of its dependencies are
# built into the program, and `gh licenses` prints them, so the build asks it, and
# stops if it can't: a newer gh that has moved them must not ship without them.
# The dashboard's are the package's own file, which lists every npm package its
# bundles read (scripts/licenses.ts). The app and the calendar helper are this
# repository's alone: they link nothing but macOS's own libraries, which the
# check below holds them to, Node with them, so nothing else needs crediting.
for binary in "$app/Contents/MacOS/Daily Focus" "$app/Contents/Helpers/Daily Focus Calendar.app/Contents/MacOS/dfcal" "$app/Contents/Helpers/node"; do
  # A library's line starts with a tab; the others name the file, once per architecture.
  foreign=$(otool -L "$binary" | awk '/^\t/ && $1 !~ /^\/(System\/Library|usr\/lib)\// { print $1 }')
  if [ -n "$foreign" ]; then
    echo "$binary links $foreign, which isn't part of macOS; credit it in the acknowledgements, then allow it here" >&2
    exit 1
  fi
done
acknowledgements="$app/Contents/Resources/Acknowledgements.txt"
credit() {
  printf '\n\n%s\n%s\n%s\n\n' "$1" "$(printf '%s' "$1" | sed 's/./=/g')" "$2" >> "$acknowledgements"
  cat "$3" >> "$acknowledgements"
}
printf '%s\n\n%s\n' "Acknowledgements" \
  "Daily Focus is MIT licensed. It carries software that others wrote, under the licences that follow." > "$acknowledgements"
credit "Node.js $node_version" "https://nodejs.org" "$node_cache/$name/LICENSE"
credit "GitHub CLI $gh_version" "https://cli.github.com" "$gh_cache/$gh_name/LICENSE"
mkdir -p "$gh_cache/config"
if ! GH_CONFIG_DIR="$gh_cache/config" GH_PAGER=cat GH_NO_UPDATE_NOTIFIER=1 NO_COLOR=1 \
  "$gh_cache/$gh_name/bin/gh" licenses > "$gh_cache/licenses.txt" 2>"$build/gh-licenses.log" \
  || ! grep -q "third-party" "$gh_cache/licenses.txt"; then
  cat "$build/gh-licenses.log" >&2
  echo "the GitHub CLI $gh_version didn't list its dependencies' licences with \`gh licenses\`; refusing to ship it without them" >&2
  exit 1
fi
rm -f "$build/gh-licenses.log"
# None of gh's dependencies may be copyleft (AGENTS.md), save the MPL's, whose
# reach ends at its own files, inside a program GitHub built and we don't change.
# One line per dependency, "name (version) - licence - link"; none read means the
# list has changed shape, which must not pass for a clean one.
gh_listed=$(grep -cE '^[^ ]+ \([^)]*\) - [^ ]+ - ' "$gh_cache/licenses.txt" || true)
gh_copyleft=$(awk -F' - ' '/^[^ ]+ \([^)]*\) - [^ ]+ - / && $2 ~ /^(A|L)?GPL|^SSPL|^EUPL|^OSL|^CC-BY-SA|^EPL|^CDDL/ { print "  " $1 " - " $2 }' "$gh_cache/licenses.txt")
if [ "$gh_listed" -eq 0 ] || [ -n "$gh_copyleft" ]; then
  [ "$gh_listed" -eq 0 ] && echo "couldn't read the licences the GitHub CLI $gh_version lists; check \`gh licenses\` by hand" >&2
  [ -n "$gh_copyleft" ] && printf 'the GitHub CLI %s depends on copyleft code, which Daily Focus can'"'"'t ship under MIT:\n%s\n' "$gh_version" "$gh_copyleft" >&2
  exit 1
fi
printf '\n\n' >> "$acknowledgements"
cat "$gh_cache/licenses.txt" >> "$acknowledgements"
if [ -n "$server" ]; then
  [ -s "$server/dist/third-party-licenses.txt" ] || { echo "$server has no dist/third-party-licenses.txt; build it with scripts/package.ts" >&2; exit 1; }
  printf '\n\n' >> "$acknowledgements"
  cat "$server/dist/third-party-licenses.txt" >> "$acknowledgements"
fi
echo "wrote the acknowledgements"

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
# What a copy of the app already installed asks of this one before it puts it in
# its own place: the same identifier and team, with nothing in it changed.
if [ "$identity" != "-" ]; then
  "$app/Contents/MacOS/Daily Focus" --check-app "$app"
fi

# The dashboard bundle holds no code macOS runs, only the files the app's Node
# does, so it takes no hardened runtime and no entitlements. Its signature seals
# every file in it, which is what the app checks before running a download: the
# same team as the app's own, and nothing added, removed or changed.
if [ -d "$dashboard" ]; then
  if [ "$identity" = "-" ]; then
    codesign --force --sign - "$dashboard"
  elif ! codesign --force --timestamp --sign "$identity" "$dashboard" 2>"$build/codesign.log"; then
    case "$identity_name" in
      "Apple Development:"*)
        rm -f "$build/codesign.log"
        codesign --force --sign "$identity" "$dashboard"
        ;;
      *)
        cat "$build/codesign.log" >&2
        exit 1
        ;;
    esac
  fi
  rm -f "$build/codesign.log"
  codesign --verify --strict "$dashboard"
  if [ "$identity" = "-" ]; then
    echo "the dashboard bundle is signed ad hoc, which no app accepts as an update"
  else
    "$app/Contents/MacOS/Daily Focus" --check-dashboard "$dashboard"
  fi
  ditto -c -k --keepParent "$dashboard" "$dashboard_zip"
fi

if [ "$test" = yes ]; then
  "$app/Contents/MacOS/Daily Focus" --self-test
fi

# Notarisation: of the disk image only. Apple checks everything in it, and its
# ticket lists the app, the app's executable, Node.js and the calendar helper, so
# one submission covers the lot. Each submission is a wait in Apple's queue, from
# seconds to most of an hour. The ticket is stapled to the disk image, which then
# opens offline. The app isn't stapled, so Gatekeeper looks its ticket up online
# when it is first opened, and a copy first opened offline is refused.
notarise() {
  # notarytool can exit 0 for a submission Apple rejected, so the verdict is read
  # from what it prints. Apple usually answers within minutes but can hold a
  # submission for hours, so the wait is bounded: past it, this fails with the
  # submission's id, and the submission carries on at Apple.
  echo "notarising $(basename "$1"); waiting up to an hour for Apple"
  result=$(xcrun notarytool submit "$1" --keychain-profile "$DAILY_FOCUS_NOTARY_PROFILE" --wait --timeout 1h 2>&1) || true
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
else
  echo "notarisation skipped: DAILY_FOCUS_NOTARY_PROFILE is not set. It needs a Developer ID Application"
  echo "certificate and credentials saved with \`xcrun notarytool store-credentials\`. Without it, the app"
  echo "opens on this Mac, but Gatekeeper refuses it on others."
fi

ditto -c -k --keepParent "$app" "$zip"
echo "built $app"
echo "and $zip"
if [ -f "$dashboard_zip" ]; then echo "and $dashboard_zip"; fi

# The disk image people download: the app beside a link to Applications, laid out
# by dmgbuild (see macos/dmg-settings.py). dmgbuild is a Python package, installed
# at a pinned version into a virtual environment under macos/build/, and it needs
# Python 3.10 or newer. Without one the image is skipped and the zip still stands.
# Hyphenated, as GitHub would rename it on a release anyway: an asset can't have a
# space. The volume it mounts as is still "Daily Focus".
dmg="$build/Daily-Focus.dmg"
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
  if [ "$notarising" = yes ]; then
    echo "and it is the disk image that is notarised, so nothing was" >&2
    exit 1
  fi
fi
