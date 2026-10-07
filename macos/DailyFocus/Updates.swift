// Which dashboard the app runs, and what it offers to install: the copy it carries,
// or a newer one it downloaded. Everything here is a plain function of its
// arguments, so `--self-test` can check it; the downloads, the signatures and the
// files are `Updater`'s.

import Foundation

/// What the dashboard may count on from the app that runs it: the flags it is
/// started with, the line it prints once it listens, the calendar helper beside the
/// app's Node, and the permissions in Info.plist and the entitlements. A dashboard
/// whose package.json asks for more, in `daily-focus.appInterface`, needs a newer
/// app. Raise both together, and only for something the dashboard can't do without.
let appInterface = 1

/// Which releases the app offers.
enum Track: String, CaseIterable {
    /// Releases cut by hand: npm's `latest`.
    case stable
    /// A build of every change merged to main: npm's `dev`.
    case development

    var distTag: String { self == .stable ? "latest" : "dev" }

    /// The track a copy of the app starts on: the one its own version came from.
    static func of(appVersion: String) -> Track {
        Version(appVersion)?.prerelease.isEmpty == false ? .development : .stable
    }
}

/// A version as semver orders them: 0.2.0-dev.3 < 0.2.0-dev.10 < 0.2.0 < 0.2.1-dev.1.
struct Version: Comparable, CustomStringConvertible {
    let core: [Int]
    let prerelease: [String]
    let description: String

    /// Nil for anything but `MAJOR.MINOR.PATCH`, with an optional `-pre.release` and
    /// `+build`. Strict, since a version also names a folder on disk.
    init?(_ text: String) {
        let allowed = CharacterSet(charactersIn: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-")
        let withBuild = text.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)
        let parts = withBuild[0].split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        let numbers = parts[0].split(separator: ".", omittingEmptySubsequences: false)
        guard numbers.count == 3,
              numbers.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) })
        else { return nil }
        let identifiers = parts.count > 1 ? parts[1].split(separator: ".", omittingEmptySubsequences: false).map(String.init) : []
        let build = withBuild.count > 1 ? withBuild[1].split(separator: ".", omittingEmptySubsequences: false).map(String.init) : []
        guard (identifiers + build).allSatisfy({ !$0.isEmpty && $0.unicodeScalars.allSatisfy(allowed.contains) }) else { return nil }
        let core = numbers.compactMap { Int($0) }
        guard core.count == 3 else { return nil }
        self.core = core
        prerelease = identifiers
        description = text
    }

    static func == (a: Version, b: Version) -> Bool {
        a.core == b.core && a.prerelease == b.prerelease
    }

    static func < (a: Version, b: Version) -> Bool {
        if a.core != b.core { return a.core.lexicographicallyPrecedes(b.core) }
        // A pre-release comes before the release it leads to.
        if a.prerelease.isEmpty != b.prerelease.isEmpty { return !a.prerelease.isEmpty }
        for (x, y) in zip(a.prerelease, b.prerelease) where x != y {
            switch (Int(x), Int(y)) {
            case let (m?, n?): return m < n
            case (.some, nil): return true
            case (nil, .some): return false
            case (nil, nil): return x < y
            }
        }
        return a.prerelease.count < b.prerelease.count
    }
}

/// A release's package.json, as far as the app reads it. npm serves one for each
/// track, and every copy of the dashboard carries its own.
struct Manifest: Decodable, Equatable {
    struct Engines: Decodable, Equatable {
        var node: String?
    }

    struct App: Decodable, Equatable {
        var appInterface: Int?
        /// The last commit to change the app, which the Release workflow stamps, so a
        /// release can tell an app that has changed since this one was built.
        var appSource: String?
    }

    var version: String
    var engines: Engines?
    var app: App?

    enum CodingKeys: String, CodingKey {
        case version, engines
        case app = "daily-focus"
    }
}

/// Whether Node.js `version` satisfies an `engines.node` of the form `>=22.18`, the
/// only form the package uses. Any other range can't be checked here, so it doesn't.
func nodeSatisfies(_ range: String?, version: String) -> Bool {
    guard let range = range?.trimmingCharacters(in: .whitespaces), !range.isEmpty else { return true }
    guard range.hasPrefix(">="),
          let need = versionNumbers(String(range.dropFirst(2)).trimmingCharacters(in: .whitespaces)),
          let have = versionNumbers(version)
    else { return false }
    return atLeast(have, need)
}

/// Whether version numbers `have` are `need` or later, missing places counting as 0.
func atLeast(_ have: [Int], _ need: [Int]) -> Bool {
    let places = max(have.count, need.count)
    let pad = { (numbers: [Int]) in numbers + Array(repeating: 0, count: places - numbers.count) }
    for (h, n) in zip(pad(have), pad(need)) where h != n {
        return h > n
    }
    return true
}

/// Why this app can't run the dashboard `manifest` describes, or nil when it can.
/// `nodeVersion` is the Node.js the app runs dashboards on, when it is known.
func appShortfall(_ manifest: Manifest, nodeVersion: String?) -> String? {
    if let needed = manifest.app?.appInterface, needed > appInterface {
        return "it needs a newer version of the app"
    }
    if let nodeVersion, !nodeSatisfies(manifest.engines?.node, version: nodeVersion) {
        return "it needs Node.js \(manifest.engines?.node ?? ""), and the app runs \(nodeVersion)"
    }
    return nil
}

/// A copy of the dashboard the app can run.
struct DashboardCopy: Equatable {
    /// Nil for a checkout named by `DAILY_FOCUS_APP_SERVER_ENTRY`, which no update replaces.
    var version: String?
    /// The script Node runs.
    var entry: String
    /// The signed bundle a downloaded copy came in; nil for the copy inside the app.
    var bundle: String?
}

/// The downloaded copies worth trying, best first: newer than the copy inside the
/// app, runnable by this app, and not given up on after failing to start. Each is
/// still checked for its signature before it runs; when none passes, the copy
/// inside the app runs.
func dashboardCandidates(bundled: String?, downloaded: [(copy: DashboardCopy, manifest: Manifest)],
                         refused: Set<String>, nodeVersion: String?) -> [DashboardCopy] {
    let floor = bundled.flatMap(Version.init)
    return downloaded
        .compactMap { item -> (Version, DashboardCopy)? in
            guard let version = Version(item.manifest.version), item.copy.version == item.manifest.version,
                  !refused.contains(item.manifest.version),
                  appShortfall(item.manifest, nodeVersion: nodeVersion) == nil
            else { return nil }
            if let floor, version <= floor { return nil }
            return (version, item.copy)
        }
        .sorted { $0.0 > $1.0 }
        .map(\.1)
}

/// What the newest release on the app's track holds for it.
struct Offer: Equatable {
    /// A dashboard newer than the one running, which this app can run.
    var dashboard: String?
    /// A release whose app is newer than this one.
    var app: String?
    /// Whether the newest dashboard needs that app, so can't be installed without it.
    var appNeeded = false
}

/// What to offer, given the newest release on the track. `running` is the version
/// of the dashboard the app runs, nil when it runs a checkout or none; `appSource`
/// is the commit this app was built from, which only a release build knows.
func offer(latest: Manifest, running: String?, appVersion: String, appSource: String?, nodeVersion: String?) -> Offer {
    var offer = Offer()
    guard let newest = Version(latest.version) else { return offer }
    if let running = running.flatMap(Version.init), newest > running {
        if appShortfall(latest, nodeVersion: nodeVersion) == nil {
            offer.dashboard = latest.version
        } else {
            offer.app = latest.version
            offer.appNeeded = true
            return offer
        }
    }
    // Every release has a disk image, but its app is new only when the app's own
    // code changed: the rest is the dashboard, which updates without one.
    if let mine = appSource, !mine.isEmpty, let theirs = latest.app?.appSource, !theirs.isEmpty, theirs != mine,
       let own = Version(appVersion), newest > own {
        offer.app = latest.version
    }
    return offer
}
