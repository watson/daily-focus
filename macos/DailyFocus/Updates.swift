// Which dashboard the app runs, the copy it carries or a newer one it downloaded,
// and what it offers to install: a newer app, or only a newer dashboard. Everything
// here is a plain function of its arguments, so `--self-test` can check it; the
// downloads, the signatures and the files are `Updater`'s.

import Foundation

/// What the dashboard may count on from the app that runs it: the flags it is
/// started with, the line it prints once it listens, the calendar helper beside the
/// app's Node, and the permissions in Info.plist and the entitlements. A dashboard
/// whose package.json asks for more, in `daily-focus.appInterface`, needs a newer
/// app. Raise both together, and only for something the dashboard can't do without.
///
/// 2: the stores moved into a folder per profile. A dashboard from before that
/// would read a moved store as empty, so an app that falls back to the copy it
/// carries must carry one that knows the folders.
let appInterface = 2

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

/// What an update puts in place. Either way the user ends up with the release's
/// version, since a release's app carries its dashboard.
enum Update: Equatable {
    /// The release's app, in place of this one.
    case app(String)
    /// Only the release's dashboard, for this app to run.
    case dashboard(String)

    var version: String {
        switch self {
        case .app(let version), .dashboard(let version): return version
        }
    }
}

/// What the newest release on the app's track holds for it.
struct Offer: Equatable {
    /// The one update the menu offers.
    var update: Update?
    /// A newer app that this copy can't put in its own place, so the menu links to
    /// its disk image. It comes beside a dashboard update when this app can run the
    /// newer dashboard.
    var download: String?
}

/// What to offer, given the newest release on the track. `running` is the version
/// of the dashboard the app runs, nil when it runs a checkout or none; `appSource`
/// is the commit this app was built from, which only a release build knows; and
/// `canReplaceApp` says whether this copy can put a newer app in its own place.
func offer(latest: Manifest, running: String?, appVersion: String, appSource: String?, nodeVersion: String?,
           canReplaceApp: Bool) -> Offer {
    var offer = Offer()
    guard let newest = Version(latest.version) else { return offer }
    let newerDashboard = running.flatMap(Version.init).map { newest > $0 } ?? false
    let runnable = appShortfall(latest, nodeVersion: nodeVersion) == nil
    // Every release builds an app, but it differs from this one only when the app's
    // own code changed. Otherwise only the dashboard did, which updates on its own.
    var newerApp = false
    if let mine = appSource, !mine.isEmpty, let theirs = latest.app?.appSource, !theirs.isEmpty, theirs != mine,
       let own = Version(appVersion), newest > own {
        newerApp = true
    }
    // The app, when it changed or the dashboard needs it, brings the dashboard with it.
    if newerApp || (newerDashboard && !runnable) {
        if canReplaceApp {
            offer.update = .app(latest.version)
            return offer
        }
        offer.download = latest.version
    }
    if newerDashboard && runnable { offer.update = .dashboard(latest.version) }
    return offer
}
