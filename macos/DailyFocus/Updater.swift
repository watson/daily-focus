// Updates without a new disk image: the app looks up the newest release on its
// track, and when the user asks, downloads that release's app, when the app's own
// code changed, or else only its dashboard. Either goes in once its signature
// checks out and nothing in the dashboard is busy.
//
// The dashboard is the npm package, signed as a bundle of its own by the same
// Developer ID as the app (`macos/build.sh`). Where the app hears of a version is
// npm, and where it fetches it is the GitHub release, but neither is trusted: what
// runs is only ever a bundle signed by the team that signed this app, with nothing
// in it changed since. It is checked again before every start, because it sits in
// a folder anything running as the user can write to, and whatever the dashboard
// runs, macOS counts as this app, with its calendar, contacts and automation
// permissions.
//
// A new app is held to the same: this app's identifier and team, checked where it
// is unpacked and again once it is in this one's place. It replaces this one in a
// single swap of the two folders, and the app relaunches into it. macOS lets an
// app change another that the same team signed without asking for App Management,
// and the permissions the user gave this one go by its identifier and team, which
// the new copy shares, rather than by its files.

import CoreServices
import Foundation
import Security

/// Where downloaded dashboards are kept: a folder per version, each holding the signed bundle.
let dashboardsURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Daily Focus/Dashboards")
let dashboardBundleName = "Daily Focus Dashboard.bundle"
let dashboardIdentifier = "dk.tson.daily-focus.dashboard"
/// The release asset holding the signed bundle, zipped.
let dashboardAsset = "Daily-Focus-Dashboard.zip"
/// The release asset holding the signed app, zipped.
let appAsset = "Daily-Focus-App.zip"
/// The identifier a new copy of the app must have: this one's.
let appIdentifier = Bundle.main.bundleIdentifier ?? "dk.tson.daily-focus"
let releasesURL = URL(string: "https://github.com/watson/daily-focus/releases")!

/// Where the newest release on `track` is looked up: npm's manifest for the
/// track's dist-tag. `DAILY_FOCUS_APP_UPDATES` replaces npm and GitHub both with one
/// base URL, `<base>/daily-focus/<tag>` and `<base>/v<version>/<asset>`, so the
/// update path can be tried against a local server.
func manifestURL(_ track: Track, environment: [String: String]) -> URL {
    let base = updatesBase(environment) ?? URL(string: "https://registry.npmjs.org")!
    return base.appendingPathComponent("daily-focus").appendingPathComponent(track.distTag)
}

/// Where release `version`'s `asset` is downloaded from.
func downloadURL(_ version: String, asset: String, environment: [String: String]) -> URL {
    let base = updatesBase(environment) ?? releasesURL.appendingPathComponent("download")
    return base.appendingPathComponent("v\(version)").appendingPathComponent(asset)
}

private func updatesBase(_ environment: [String: String]) -> URL? {
    guard let text = environment["DAILY_FOCUS_APP_UPDATES"]?.trimmingCharacters(in: .whitespaces), !text.isEmpty else { return nil }
    return URL(string: text)
}

/// The team that signed this app, which a download must share. Nil for an ad-hoc
/// signature, which names none: such a copy runs only the dashboard it carries, and
/// never replaces itself.
let ownTeam: String? = {
    var code: SecCode?
    var staticCode: SecStaticCode?
    var info: CFDictionary?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
          SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
          SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let info = info as? [String: Any]
    else { return nil }
    return info[kSecCodeInfoTeamIdentifier as String] as? String
}()

/// Why `bundle` isn't one to run, or nil when it is `identifier`, signed by `team`
/// with nothing in it added, removed or changed since.
func signatureProblem(bundle: URL, identifier: String, team: String?) -> String? {
    guard let team, !team.isEmpty else { return "this copy of the app has no team signature to check it against" }
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(bundle as CFURL, [], &code) == errSecSuccess, let code else {
        return "there is no bundle at \(bundle.path)"
    }
    var requirement: SecRequirement?
    let text = "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(team)\""
    guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess else {
        return "its requirement couldn't be read"
    }
    var error: Unmanaged<CFError>?
    let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode)
    let status = SecStaticCodeCheckValidityWithErrors(code, flags, requirement, &error)
    if status == errSecSuccess { return nil }
    let reason = (SecCopyErrorMessageString(status, nil) as String?) ?? "error \(status)"
    error?.release()
    return "its signature doesn't check out: \(reason)"
}

/// The package.json inside a dashboard.
func readManifest(server: URL) -> Manifest? {
    guard let data = try? Data(contentsOf: server.appendingPathComponent("package.json")) else { return nil }
    return try? JSONDecoder().decode(Manifest.self, from: data)
}

/// The copy inside the app, or a development checkout when one is named.
func bundledDashboard(environment: [String: String], resources: URL?) -> DashboardCopy {
    let entry = serverEntry(environment: environment, resources: resources)
    if environment["DAILY_FOCUS_APP_SERVER_ENTRY"]?.trimmingCharacters(in: .whitespaces).isEmpty == false {
        return DashboardCopy(version: nil, entry: entry, bundle: nil)
    }
    let server = (resources ?? URL(fileURLWithPath: "/")).appendingPathComponent("server")
    return DashboardCopy(version: readManifest(server: server)?.version ?? "", entry: entry, bundle: nil)
}

/// The dashboards downloaded so far, as their package.json describes them.
func downloadedDashboards() -> [(copy: DashboardCopy, manifest: Manifest)] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: dashboardsURL.path)) ?? []
    return names.filter { !$0.hasPrefix(".") }.compactMap { name in
        let bundle = dashboardsURL.appendingPathComponent(name).appendingPathComponent(dashboardBundleName)
        let server = bundle.appendingPathComponent("Contents/Resources/server")
        guard let manifest = readManifest(server: server) else { return nil }
        let entry = server.appendingPathComponent("dist/cli.js").path
        return (DashboardCopy(version: name, entry: entry, bundle: bundle.path), manifest)
    }
}

/// The dashboard to start, and what was passed over on the way there, for the log.
func chooseDashboard(environment: [String: String], resources: URL?, refused: Set<String>,
                     nodeVersion: String) -> (copy: DashboardCopy, notes: [String]) {
    let bundled = bundledDashboard(environment: environment, resources: resources)
    // A checkout is being worked on, and no download replaces it.
    guard let floor = bundled.version else { return (bundled, []) }
    var notes: [String] = []
    let candidates = dashboardCandidates(bundled: floor.isEmpty ? nil : floor, downloaded: downloadedDashboards(),
                                         refused: refused, nodeVersion: nodeVersion)
    for candidate in candidates {
        guard let bundle = candidate.bundle else { continue }
        if let problem = signatureProblem(bundle: URL(fileURLWithPath: bundle), identifier: dashboardIdentifier, team: ownTeam) {
            notes.append("not running dashboard \(candidate.version ?? "") from \(bundle): \(problem)")
            continue
        }
        return (candidate, notes)
    }
    return (bundled, notes)
}

// The versions that failed to start, so the app went back to an older one. They
// aren't chosen again until the user installs them again.
private let refusedKey = "refusedDashboards"

func refusedDashboards() -> Set<String> {
    Set(UserDefaults.standard.stringArray(forKey: refusedKey) ?? [])
}

func setRefused(_ version: String, _ refused: Bool) {
    var versions = refusedDashboards()
    if refused { versions.insert(version) } else { versions.remove(version) }
    UserDefaults.standard.set(versions.sorted(), forKey: refusedKey)
}

struct UpdateError: Error, CustomStringConvertible {
    let description: String
}

/// Unpacks a download before its signature can be checked, so what matters is that
/// ditto keeps every entry inside the folder it unpacks to: it does so for `..` and
/// absolute paths, and writes a link as a plain file, which nothing then follows.
private func unzip(_ zip: URL, into folder: URL) throws {
    let ditto = Process()
    ditto.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
    ditto.arguments = ["-x", "-k", zip.path, folder.path]
    ditto.standardOutput = FileHandle.nullDevice
    ditto.standardError = FileHandle.nullDevice
    try ditto.run()
    ditto.waitUntilExit()
    guard ditto.terminationStatus == 0 else { throw UpdateError(description: "the download isn't a zip that can be opened") }
}

/// Unpacks a downloaded dashboard, checks it and puts it with the others. Runs off
/// the main queue: the download is gone once the task that made it returns.
func installDashboard(zip: URL, version: String, team: String?) throws {
    guard Version(version) != nil else { throw UpdateError(description: "\(version) isn't a version") }
    let files = FileManager.default
    try files.createDirectory(at: dashboardsURL, withIntermediateDirectories: true)
    let staging = dashboardsURL.appendingPathComponent(".staging-\(UUID().uuidString)")
    defer { try? files.removeItem(at: staging) }
    try unzip(zip, into: staging)

    let bundle = staging.appendingPathComponent(dashboardBundleName)
    if let problem = signatureProblem(bundle: bundle, identifier: dashboardIdentifier, team: team) {
        throw UpdateError(description: problem)
    }
    let server = bundle.appendingPathComponent("Contents/Resources/server")
    guard let manifest = readManifest(server: server), manifest.version == version else {
        throw UpdateError(description: "it says it is a version other than \(version)")
    }
    let target = dashboardsURL.appendingPathComponent(version)
    try? files.removeItem(at: target)
    try files.createDirectory(at: target, withIntermediateDirectories: true)
    try files.moveItem(at: bundle, to: target.appendingPathComponent(dashboardBundleName))
}

/// Why the app at `bundle` can't put a newer one in its place, or nil when it can.
/// When it can't, the menu links to the new app's disk image instead.
func replacementProblem(bundle: URL, team: String?) -> String? {
    guard let team, !team.isEmpty else { return "it has no Developer ID signature to check a download against" }
    // An app opened from the folder it was downloaded to, without being moved, runs
    // from a read-only copy macOS made of it.
    if bundle.path.contains("/AppTranslocation/") {
        return "macOS runs it from a temporary copy until it is moved out of the folder it was downloaded to"
    }
    if (try? bundle.resourceValues(forKeys: [.volumeIsReadOnlyKey]))?.volumeIsReadOnly == true {
        return "it runs from the disk image it came in"
    }
    // The swap moves this folder out of its parent and the new one in, which takes
    // the right to change both.
    let parent = bundle.deletingLastPathComponent()
    let files = FileManager.default
    guard files.isWritableFile(atPath: parent.path), files.isWritableFile(atPath: bundle.path) else {
        return "this account can't change \(parent.path)"
    }
    return nil
}

/// Unpacks a downloaded app and checks it, in a folder of its own on the volume
/// `installed` is on, since the swap that puts it in place can't cross volumes.
/// Returns where it is. Runs off the main queue: the download is gone once the task
/// that made it returns.
func stageApp(zip: URL, version: String, team: String?, replacing installed: URL) throws -> URL {
    guard Version(version) != nil else { throw UpdateError(description: "\(version) isn't a version") }
    let files = FileManager.default
    let staging = try files.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: installed, create: true)
    do {
        try unzip(zip, into: staging)
        let apps = try files.contentsOfDirectory(atPath: staging.path).filter { $0.hasSuffix(".app") }
        guard apps.count == 1 else { throw UpdateError(description: "the download doesn't hold an app") }
        let app = staging.appendingPathComponent(apps[0])
        if let problem = appProblem(app, version: version, team: team) { throw UpdateError(description: problem) }
        return app
    } catch {
        try? files.removeItem(at: staging)
        throw error
    }
}

/// Why `app` isn't release `version` of this app, signed by `team`, or nil when it is.
private func appProblem(_ app: URL, version: String, team: String?) -> String? {
    if let problem = signatureProblem(bundle: app, identifier: appIdentifier, team: team) { return problem }
    // From the file, not through Bundle, which answers for this app's own path with
    // what it read at launch.
    let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
    guard info?["CFBundleShortVersionString"] as? String == version else {
        return "it says it is a version other than \(version)"
    }
    return nil
}

/// Puts the app checked at `staged` in the place of the one at `installed`, in one
/// swap of the two folders, and checks it again there: one that no longer checks
/// out is swapped back. Either way `staged` is left holding the app not in place.
func putAppInPlace(installed: URL, staged: URL, version: String, team: String?) throws {
    try swapFolders(staged, installed)
    if let problem = appProblem(installed, version: version, team: team) {
        try? swapFolders(staged, installed)
        throw UpdateError(description: problem)
    }
}

/// Exchanges two folders on one volume in a single step, so neither path is ever empty.
func swapFolders(_ a: URL, _ b: URL) throws {
    guard renamex_np(a.path, b.path, UInt32(RENAME_SWAP)) == 0 else {
        throw UpdateError(description: "\(b.path) couldn't be replaced: \(String(cString: strerror(errno)))")
    }
}

/// Removes downloaded dashboards the one now running makes redundant: those no
/// newer than it, and those that failed to start. A newer one stays, since it may
/// be an update downloaded and waiting for the dashboard to be idle.
func removeOldDashboards(running: DashboardCopy, refused: Set<String>) -> [String] {
    guard let current = running.version.flatMap(Version.init) else { return [] }
    var removed: [String] = []
    for (copy, _) in downloadedDashboards() {
        guard let name = copy.version, copy.bundle != running.bundle else { continue }
        let version = Version(name)
        if refused.contains(name) || version == nil || version! <= current {
            if (try? FileManager.default.removeItem(at: dashboardsURL.appendingPathComponent(name))) != nil {
                removed.append(name)
            }
        }
    }
    return removed
}

/// Nothing cached, since every answer is about now.
private let updateSession: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 30
    // An app is tens of megabytes, which a slow connection takes minutes over.
    configuration.timeoutIntervalForResource = 30 * 60
    return URLSession(configuration: configuration)
}()

private let trackKey = "updateTrack"
private let automaticKey = "updateAutomatically"
private let askedAutomaticKey = "askedAboutAutomaticUpdates"

@MainActor
final class Updater {
    enum Phase: Equatable {
        case idle
        case downloading(Update)
        /// Downloaded and checked: it goes in once the dashboard is idle.
        case ready(Update)
    }

    var onChange: (() -> Void)?
    private(set) var phase: Phase = .idle {
        didSet { if phase != oldValue { onChange?() } }
    }
    private(set) var checking = false
    /// The newest release on the track, from the last check that worked.
    private(set) var latest: Manifest?
    private(set) var checkedAt: Date?
    /// Why the last check failed, when it did.
    private(set) var checkError: String?

    let appVersion: String
    /// The commit this app was built from, when it is a release's build.
    let appSource: String?
    private let environment: [String: String]
    private let log: LogFile
    /// The app downloaded and checked, until it goes in.
    private var stagedApp: URL?

    init(environment: [String: String], log: LogFile) {
        let info = Bundle.main.infoDictionary ?? [:]
        appVersion = info["CFBundleShortVersionString"] as? String ?? "unknown"
        appSource = (info["DFAppSource"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.environment = environment
        self.log = log
    }

    var track: Track {
        get { UserDefaults.standard.string(forKey: trackKey).flatMap(Track.init) ?? Track.of(appVersion: appVersion) }
        set {
            guard newValue != track else { return }
            UserDefaults.standard.set(newValue.rawValue, forKey: trackKey)
            latest = nil
            checkedAt = nil
            checkError = nil
            onChange?()
            check()
        }
    }

    /// Whether updates go in on their own, once the dashboard has been quiet a while.
    /// Off until the user turns it on.
    var automatic: Bool {
        get { UserDefaults.standard.bool(forKey: automaticKey) }
        set {
            guard newValue != automatic else { return }
            UserDefaults.standard.set(newValue, forKey: automaticKey)
            askedAboutAutomatic = true
            onChange?()
        }
    }

    /// Whether the user has been asked whether updates should go in on their own.
    var askedAboutAutomatic: Bool {
        get { UserDefaults.standard.bool(forKey: askedAutomaticKey) }
        set { UserDefaults.standard.set(newValue, forKey: askedAutomaticKey) }
    }

    /// Looks up the newest release on the track; `done` gets why that failed, if it did.
    func check(then done: ((String?) -> Void)? = nil) {
        if checking {
            done?(nil)
            return
        }
        checking = true
        onChange?()
        let track = self.track
        let url = manifestURL(track, environment: environment)
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        updateSession.dataTask(with: request) { [weak self] data, response, error in
            let code = (response as? HTTPURLResponse)?.statusCode
            let manifest = data.flatMap { try? JSONDecoder().decode(Manifest.self, from: $0) }
            let reason = error?.localizedDescription
            DispatchQueue.main.async {
                guard let self else { return }
                self.checking = false
                // The track changed while this was asked, and asking for the new one
                // waited for this answer, which is now beside the point.
                guard track == self.track else {
                    self.check(then: done)
                    return
                }
                if code == 200, let manifest, Version(manifest.version) != nil {
                    self.latest = manifest
                    self.checkedAt = Date()
                    self.checkError = nil
                } else {
                    self.checkError = reason ?? code.map { "\(url.host ?? "the registry") answered HTTP \($0)" } ?? "nothing answered"
                    self.log.note("couldn't check for updates at \(url): \(self.checkError!)")
                }
                self.onChange?()
                done?(self.checkError)
            }
        }.resume()
    }

    /// Downloads and checks release `update`; `done` gets why that failed, if it did.
    /// Nothing is restarted here: see `AppDelegate`.
    func install(_ update: Update, then done: @escaping (String?) -> Void) {
        guard phase == .idle else { return }
        guard let team = ownTeam else {
            done("This copy of Daily Focus has no Developer ID signature, so it can't check a download. Install the app from a release.")
            return
        }
        let version = update.version
        let what: String
        let asset: String
        switch update {
        case .app:
            what = "Daily Focus"
            asset = appAsset
        case .dashboard:
            what = "Dashboard"
            asset = dashboardAsset
            setRefused(version, false)
        }
        phase = .downloading(update)
        let url = downloadURL(version, asset: asset, environment: environment)
        let installed = Bundle.main.bundleURL
        log.note("downloading \(what) \(version) from \(url)")
        updateSession.downloadTask(with: url) { [weak self] file, response, error in
            let code = (response as? HTTPURLResponse)?.statusCode
            var problem: String?
            var staged: URL?
            if let file, code == 200 {
                do {
                    switch update {
                    case .app: staged = try stageApp(zip: file, version: version, team: team, replacing: installed)
                    case .dashboard: try installDashboard(zip: file, version: version, team: team)
                    }
                } catch {
                    problem = "\(what) \(version) wasn't installed: \(error)."
                }
            } else if code == 404 {
                problem = "Release \(version) has no \(asset) to download."
            } else {
                problem = "\(what) \(version) couldn't be downloaded: \(error?.localizedDescription ?? "HTTP \(code ?? 0)")."
            }
            DispatchQueue.main.async {
                guard let self else { return }
                if let problem {
                    self.log.note(problem)
                    self.phase = .idle
                } else {
                    if let staged {
                        self.log.note("downloaded and checked Daily Focus \(version), in \(staged.path)")
                        self.stagedApp = staged
                    } else {
                        self.log.note("installed dashboard \(version) in \(dashboardsURL.appendingPathComponent(version).path)")
                    }
                    self.phase = .ready(update)
                }
                done(problem)
            }
        }.resume()
    }

    /// Puts the downloaded app in this one's place; `done` gets why that failed, if it
    /// did. Relaunching into it is the caller's: see `AppDelegate`.
    func replaceApp(then done: @escaping (String?) -> Void) {
        guard case .ready(.app(let version)) = phase, let staged = stagedApp else { return }
        stagedApp = nil
        let installed = Bundle.main.bundleURL
        let team = ownTeam
        log.note("putting Daily Focus \(version) in place of \(appVersion), at \(installed.path)")
        DispatchQueue.global().async { [weak self, log] in
            var problem: String?
            do {
                try putAppInPlace(installed: installed, staged: staged, version: version, team: team)
                // So that Launch Services opens it as the version it now is.
                LSRegisterURL(installed as CFURL, true)
            } catch {
                problem = "Daily Focus \(version) wasn't installed: \(error)."
            }
            // The folder it was checked in, which now holds whichever app isn't in place.
            try? FileManager.default.removeItem(at: staged.deletingLastPathComponent())
            DispatchQueue.main.async {
                if let problem {
                    log.note(problem)
                    self?.phase = .idle
                } else {
                    log.note("installed Daily Focus \(version) at \(installed.path)")
                }
                done(problem)
            }
        }
    }

    /// Throws away a downloaded app that never went in, as the app quits.
    func discardStagedApp() {
        guard let staged = stagedApp else { return }
        stagedApp = nil
        try? FileManager.default.removeItem(at: staged.deletingLastPathComponent())
    }

    /// The dashboard has started: an update waiting for that is done, and older
    /// downloads can go.
    func started(_ copy: DashboardCopy) {
        if case .ready(.dashboard(let version)) = phase, version == copy.version { phase = .idle }
        let refused = refusedDashboards()
        DispatchQueue.global().async { [log] in
            for version in removeOldDashboards(running: copy, refused: refused) {
                log.note("removed dashboard \(version), which \(copy.version ?? "the running one") replaces")
            }
        }
    }

    /// The update waiting to run didn't: it failed to start, or failed its check.
    func gaveUp(on version: String) {
        if case .ready(.dashboard(let waiting)) = phase, waiting == version { phase = .idle }
    }
}
