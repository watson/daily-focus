// Updates to the dashboard, without a new disk image: the app looks up the newest
// release on its track, downloads that release's dashboard when the user asks,
// and runs it once its signature checks out.
//
// The dashboard is the npm package, signed as a bundle of its own by the same
// Developer ID as the app (`macos/build.sh`). Where the app hears of a version is
// npm, and where it fetches it is the GitHub release, but neither is trusted: what
// runs is only ever a bundle signed by the team that signed this app, with nothing
// in it changed since. It is checked again before every start, because it sits in
// a folder anything running as the user can write to, and whatever the dashboard
// runs, macOS counts as this app, with its calendar, contacts and automation
// permissions.

import Foundation
import Security

/// Where downloaded dashboards are kept: a folder per version, each holding the signed bundle.
let dashboardsURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Daily Focus/Dashboards")
let dashboardBundleName = "Daily Focus Dashboard.bundle"
let dashboardIdentifier = "dk.tson.daily-focus.dashboard"
/// The release asset holding the signed bundle, zipped.
let dashboardAsset = "Daily-Focus-Dashboard.zip"
let releasesURL = URL(string: "https://github.com/watson/daily-focus/releases")!

/// Where the newest release on `track` is looked up: npm's manifest for the
/// track's dist-tag. `DAILY_FOCUS_APP_UPDATES` replaces npm and GitHub both with one
/// base URL, `<base>/daily-focus/<tag>` and `<base>/v<version>/<asset>`, so the
/// update path can be tried against a local server.
func manifestURL(_ track: Track, environment: [String: String]) -> URL {
    let base = updatesBase(environment) ?? URL(string: "https://registry.npmjs.org")!
    return base.appendingPathComponent("daily-focus").appendingPathComponent(track.distTag)
}

/// Where release `version`'s dashboard is downloaded from.
func downloadURL(_ version: String, environment: [String: String]) -> URL {
    let base = updatesBase(environment) ?? releasesURL.appendingPathComponent("download")
    return base.appendingPathComponent("v\(version)").appendingPathComponent(dashboardAsset)
}

private func updatesBase(_ environment: [String: String]) -> URL? {
    guard let text = environment["DAILY_FOCUS_APP_UPDATES"]?.trimmingCharacters(in: .whitespaces), !text.isEmpty else { return nil }
    return URL(string: text)
}

/// The team that signed this app, which a downloaded dashboard must share. Nil for an
/// ad-hoc signature, which names none: such a copy runs only the dashboard it carries.
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

/// Why `bundle` isn't a dashboard to run, or nil when it is one signed by `team` with
/// nothing in it added, removed or changed since.
func signatureProblem(bundle: URL, team: String?) -> String? {
    guard let team, !team.isEmpty else { return "this copy of the app has no team signature to check it against" }
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(bundle as CFURL, [], &code) == errSecSuccess, let code else {
        return "there is no bundle at \(bundle.path)"
    }
    var requirement: SecRequirement?
    let text = "anchor apple generic and identifier \"\(dashboardIdentifier)\" and certificate leaf[subject.OU] = \"\(team)\""
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
        if let problem = signatureProblem(bundle: URL(fileURLWithPath: bundle), team: ownTeam) {
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

/// Unpacks a downloaded dashboard, checks it and puts it with the others. Runs off
/// the main queue: the download is gone once the task that made it returns.
func installDashboard(zip: URL, version: String, team: String?) throws {
    guard Version(version) != nil else { throw UpdateError(description: "\(version) isn't a version") }
    let files = FileManager.default
    try files.createDirectory(at: dashboardsURL, withIntermediateDirectories: true)
    let staging = dashboardsURL.appendingPathComponent(".staging-\(UUID().uuidString)")
    defer { try? files.removeItem(at: staging) }
    // Unpacked before its signature can be checked, so what matters is that ditto
    // keeps every entry inside the folder it unpacks to: it does so for `..` and
    // absolute paths, and writes a link as a plain file, which nothing then follows.
    let ditto = Process()
    ditto.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
    ditto.arguments = ["-x", "-k", zip.path, staging.path]
    ditto.standardOutput = FileHandle.nullDevice
    ditto.standardError = FileHandle.nullDevice
    try ditto.run()
    ditto.waitUntilExit()
    guard ditto.terminationStatus == 0 else { throw UpdateError(description: "the download isn't a zip that can be opened") }

    let bundle = staging.appendingPathComponent(dashboardBundleName)
    if let problem = signatureProblem(bundle: bundle, team: team) { throw UpdateError(description: problem) }
    let server = bundle.appendingPathComponent("Contents/Resources/server")
    guard let manifest = readManifest(server: server), manifest.version == version else {
        throw UpdateError(description: "it says it is a version other than \(version)")
    }
    let target = dashboardsURL.appendingPathComponent(version)
    try? files.removeItem(at: target)
    try files.createDirectory(at: target, withIntermediateDirectories: true)
    try files.moveItem(at: bundle, to: target.appendingPathComponent(dashboardBundleName))
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
    configuration.timeoutIntervalForResource = 300
    return URLSession(configuration: configuration)
}()

private let trackKey = "updateTrack"

@MainActor
final class Updater {
    enum Phase: Equatable {
        case idle
        case downloading(String)
        /// Downloaded and checked: the dashboard restarts into it once it is idle.
        case ready(String)
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

    /// Downloads and checks release `version`'s dashboard; `done` gets why that failed,
    /// if it did. The dashboard isn't restarted here: see `AppDelegate`.
    func install(_ version: String, then done: @escaping (String?) -> Void) {
        guard phase == .idle else { return }
        guard let team = ownTeam else {
            done("This copy of Daily Focus has no Developer ID signature, so it can't check a download. Install the app from a release.")
            return
        }
        phase = .downloading(version)
        setRefused(version, false)
        let url = downloadURL(version, environment: environment)
        log.note("downloading dashboard \(version) from \(url)")
        updateSession.downloadTask(with: url) { [weak self] file, response, error in
            let code = (response as? HTTPURLResponse)?.statusCode
            var problem: String?
            if let file, code == 200 {
                do {
                    try installDashboard(zip: file, version: version, team: team)
                } catch {
                    problem = "Dashboard \(version) wasn't installed: \(error)."
                }
            } else if code == 404 {
                problem = "Release \(version) has no dashboard to download."
            } else {
                problem = "Dashboard \(version) couldn't be downloaded: \(error?.localizedDescription ?? "HTTP \(code ?? 0)")."
            }
            DispatchQueue.main.async {
                guard let self else { return }
                if let problem {
                    self.log.note(problem)
                    self.phase = .idle
                } else {
                    self.log.note("installed dashboard \(version) in \(dashboardsURL.appendingPathComponent(version).path)")
                    self.phase = .ready(version)
                }
                done(problem)
            }
        }.resume()
    }

    /// The dashboard has started: an update waiting for that is done, and older
    /// downloads can go.
    func started(_ copy: DashboardCopy) {
        if case .ready(let version) = phase, version == copy.version { phase = .idle }
        let refused = refusedDashboards()
        DispatchQueue.global().async { [log] in
            for version in removeOldDashboards(running: copy, refused: refused) {
                log.note("removed dashboard \(version), which \(copy.version ?? "the running one") replaces")
            }
        }
    }

    /// The update waiting to run didn't: it failed to start, or failed its check.
    func gaveUp(on version: String) {
        if case .ready(let waiting) = phase, waiting == version { phase = .idle }
    }
}
