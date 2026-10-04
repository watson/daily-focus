// Runs the dashboard server as a child of the app and keeps it running.
//
// This is what `npm run service` asks of launchd, done by the app instead: start
// the server, start it again when it stops without being asked to, and stop it
// cleanly on the way out. Unlike the LaunchAgent, the app also has to notice a
// dashboard that is already running, because the same Mac may have one from
// `npm run service`, and two servers on one store would be two writers.

import Darwin
import Foundation

/// The dashboard's output and the app's notes about it, appended to across starts.
let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Daily Focus.log")

/// How long to wait before starting the server again after its `attempt`th stop in a row.
func restartDelay(attempt: Int) -> TimeInterval {
    let schedule: [TimeInterval] = [1, 2, 5, 10, 30]
    return schedule[min(max(attempt, 0), schedule.count - 1)]
}

/// The attempt count to carry on with after a stop. A server that stayed up for a
/// minute was working, so whatever stopped it is a new problem, not the old one again.
func restartAttempt(previous: Int, uptime: TimeInterval) -> Int {
    uptime >= 60 ? 0 : previous
}

/// The dashboard's address, from the line the server prints once it listens:
/// `[daily-focus] dashboard  http://127.0.0.1:4321`.
func dashboardURL(fromLine line: String) -> URL? {
    guard let marker = line.range(of: "[daily-focus] dashboard") else { return nil }
    let text = line[marker.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
    guard let separator = text.range(of: "://"),
          let colon = text.lastIndex(of: ":"),
          colon >= separator.upperBound
    else { return nil }
    let scheme = String(text[..<separator.lowerBound])
    var host = String(text[separator.upperBound..<colon])
    let port = text[text.index(after: colon)...]
    guard scheme == "http" || scheme == "https", !port.isEmpty, port.allSatisfy(\.isASCII), port.allSatisfy(\.isNumber)
    else { return nil }
    // A wildcard bind listens on loopback as well, and loopback is a name the
    // server always answers to; the wildcard itself isn't an address at all.
    if host.isEmpty || host == "0.0.0.0" || host == "::" || host == "[::]" {
        host = "127.0.0.1"
    } else if host.contains(":") && !host.hasPrefix("[") {
        host = "[\(host)]"
    }
    return URL(string: "\(scheme)://\(host):\(port)")
}

/// The port to look for an existing dashboard on, or nil when there is no telling
/// in advance: `0` asks the server for any free port.
func probePort(_ environment: [String: String]) -> Int? {
    guard let text = environment["DAILY_FOCUS_PORT"]?.trimmingCharacters(in: .whitespaces), !text.isEmpty else {
        return 4321
    }
    guard let port = Int(text) else { return 4321 }
    if port == 0 { return nil }
    return (1...65535).contains(port) ? port : 4321
}

/// The script Node runs: a development checkout's when one is named, else the copy in the app.
func serverEntry(environment: [String: String], resources: URL?) -> String {
    if let entry = environment["DAILY_FOCUS_APP_SERVER_ENTRY"]?.trimmingCharacters(in: .whitespaces), !entry.isEmpty {
        return entry
    }
    return (resources ?? URL(fileURLWithPath: "/")).appendingPathComponent("server/dist/cli.js").path
}

/// The server's environment: the app's own, with the PATH that finds Node and the
/// CLIs, and the calendar helper this app carries unless the user named another.
func childEnvironment(_ base: [String: String], path: String, calendarHelper: String?) -> [String: String] {
    var environment = base
    environment["PATH"] = path
    if let calendarHelper, (environment["DAILY_FOCUS_CALENDAR_APP"] ?? "").trimmingCharacters(in: .whitespaces).isEmpty {
        environment["DAILY_FOCUS_CALENDAR_APP"] = calendarHelper
    }
    return environment
}

/// One session for everything the app asks the dashboard: nothing cached, since
/// every answer is about now, and no proxy, since the dashboard is on this machine.
private let dashboardSession: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.connectionProxyDictionary = [:]
    return URLSession(configuration: configuration)
}()

/// Asks the dashboard something and hands back, on the main queue, the HTTP status
/// (nil when nothing answered) and the body.
func fetch(_ url: URL, method: String = "GET", timeout: TimeInterval = 10, then done: @escaping (Int?, Data?) -> Void) {
    var request = URLRequest(url: url, timeoutInterval: timeout)
    request.httpMethod = method
    if method == "POST" {
        // The server refuses a POST that isn't JSON, because a form on another
        // site can't send one, and that is what keeps other pages from acting here.
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
    }
    dashboardSession.dataTask(with: request) { data, response, _ in
        let code = (response as? HTTPURLResponse)?.statusCode
        DispatchQueue.main.async { done(code, data) }
    }.resume()
}

/// The log file, written to from the main thread and from the pipe's.
final class LogFile: @unchecked Sendable {
    private let lock = NSLock()
    private let handle: FileHandle?
    private let stamp: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter
    }()

    init(url: URL) {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        // O_APPEND, so that a line is never written over whatever another writer put there first.
        let descriptor = Darwin.open(url.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        handle = descriptor >= 0 ? FileHandle(fileDescriptor: descriptor, closeOnDealloc: true) : nil
    }

    func write(_ data: Data) {
        lock.lock()
        defer { lock.unlock() }
        try? handle?.write(contentsOf: data)
    }

    /// A line from the app itself, set apart from the server's own `[daily-focus]` lines.
    func note(_ text: String) {
        lock.lock()
        let now = stamp.string(from: Date())
        lock.unlock()
        write(Data("[daily-focus app] \(now) \(text)\n".utf8))
    }
}

// The app remembers the server it started, so that a server left behind when the
// app was killed can be stopped on the next launch. Without this, that server would
// look like a dashboard someone else runs, and the app would refuse to touch it.
//
// A pid alone is not enough to know it again: after a reboot the same number can
// belong to anything, the `npm run service` dashboard included, which runs the same
// Node under launchd. The binary and the moment it started are.
private let childPIDKey = "dashboardPID"
private let childNodeKey = "dashboardNode"
private let childStartKey = "dashboardStarted"

private func executablePath(of pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: 4096)
    let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    return length > 0 ? String(cString: buffer) : nil
}

/// The parent and the start time, in microseconds, of a running process.
private func runningProcess(_ pid: pid_t) -> (parent: pid_t, started: Int)? {
    guard pid > 0 else { return nil }
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
    return (pid_t(info.pbi_ppid), Int(info.pbi_start_tvsec) * 1_000_000 + Int(info.pbi_start_tvusec))
}

private func realPath(_ path: String) -> String {
    guard let resolved = realpath(path, nil) else { return path }
    defer { free(resolved) }
    return String(cString: resolved)
}

/// What became of the server an earlier launch of the app recorded.
private enum Leftover {
    /// It isn't running any more, or the pid belongs to something else now.
    case gone
    /// It was still running, without the app that started it, and has been stopped.
    case stopped
    /// It is still running under its app: a second copy of the app is running it.
    case owned
}

private func stopLeftoverServer(pid: pid_t, node: String, started: Int) -> Leftover {
    guard let running = runningProcess(pid), running.started == started, executablePath(of: pid) == node else {
        return .gone
    }
    // An orphan is handed to launchd; anything else still has the app that started it.
    guard running.parent == 1 else { return .owned }
    kill(pid, SIGTERM)
    for _ in 0..<50 {
        if kill(pid, 0) != 0 { return .stopped }
        usleep(100_000)
    }
    kill(pid, SIGKILL)
    return .stopped
}

@MainActor
final class Dashboard {
    enum State: Equatable {
        /// Looking for a dashboard that is already running, for the user's PATH, and for Node.
        case preparing
        /// No Node, or one too old to run the server.
        case needsNode
        /// The server can't be started, for the reason given.
        case blocked(String)
        /// The server has been started and hasn't said where it listens yet.
        case starting
        case running(URL)
        /// Waiting to start the server again.
        case restarting
        /// Another process runs the dashboard on this port, so the app only watches it.
        case attached(URL)
        case stopping
        case stopped
    }

    var onChange: (() -> Void)?
    private(set) var state: State = .preparing {
        didSet { if state != oldValue { onChange?() } }
    }

    let environment = ProcessInfo.processInfo.environment
    private let log = LogFile(url: logURL)
    private var path: String?
    private var node: String?
    private var process: Process?
    private var startedAt = Date()
    private var output = Data()
    private var attempt = 0
    private var pendingStart: DispatchWorkItem?
    private var stopRequested = false
    private var restartRequested = false
    private var whenStopped: (() -> Void)?

    var url: URL? {
        switch state {
        case .running(let url), .attached(let url): return url
        default: return nil
        }
    }

    var isAttached: Bool {
        if case .attached = state { return true }
        return false
    }

    /// Whether quitting has a server to stop first.
    var hasChild: Bool { process?.isRunning == true }

    /// Where a dashboard is expected before the app knows for sure, for a
    /// notification clicked while it is still starting.
    var expectedURL: URL? {
        url ?? probePort(environment).flatMap { URL(string: "http://127.0.0.1:\($0)") }
    }

    func start() {
        let defaults = UserDefaults.standard
        let leftover = pid_t(defaults.integer(forKey: childPIDKey))
        let leftoverNode = defaults.string(forKey: childNodeKey) ?? ""
        let leftoverStarted = defaults.integer(forKey: childStartKey)
        let log = self.log
        DispatchQueue.global().async {
            let found = stopLeftoverServer(pid: leftover, node: leftoverNode, started: leftoverStarted)
            if found == .stopped {
                log.note("stopped the dashboard (process \(leftover)) an earlier launch of the app left running")
            }
            DispatchQueue.main.async {
                if found != .owned { self.forgetChild() }
                self.probeThenSpawn()
            }
        }
    }

    /// Stops the server and starts it again, with the user's PATH read afresh, so
    /// that a CLI installed since the app started is found without quitting it.
    func restart() {
        switch state {
        case .attached, .stopping, .stopped, .preparing: return
        default: break
        }
        pendingStart?.cancel()
        pendingStart = nil
        attempt = 0
        path = nil
        node = nil
        state = .restarting
        if let child = process, child.isRunning {
            restartRequested = true
            terminate(child)
        } else {
            probeThenSpawn()
        }
    }

    /// Stops the server, if the app runs one, and calls `done` once it has exited.
    func stop(then done: @escaping () -> Void) {
        pendingStart?.cancel()
        pendingStart = nil
        guard let child = process, child.isRunning else {
            state = .stopped
            done()
            return
        }
        whenStopped = done
        if stopRequested { return }
        stopRequested = true
        restartRequested = false
        state = .stopping
        terminate(child)
    }

    private func probeThenSpawn() {
        guard state != .stopping, state != .stopped else { return }
        guard let port = probePort(environment), let base = URL(string: "http://127.0.0.1:\(port)") else {
            prepareThenSpawn()
            return
        }
        fetch(base.appendingPathComponent("api/health"), timeout: 2) { [weak self] code, data in
            guard let self, self.state != .stopping, self.state != .stopped else { return }
            if code == 200, isDashboardHealth(data) {
                self.log.note("a dashboard already answers at \(base); watching it rather than starting another")
                self.state = .attached(base)
            } else if let code {
                self.log.note("port \(port) answers HTTP \(code), and not as a dashboard")
                self.scheduleStart(showing: .blocked("Port \(port) is taken by another program"))
            } else {
                self.prepareThenSpawn()
            }
        }
    }

    private func prepareThenSpawn() {
        if let node, path != nil {
            spawn(node: node)
            return
        }
        let environment = self.environment
        DispatchQueue.global().async { [weak self] in
            let hydrated = hydratedPath(environment: environment)
            let check = checkNode(on: hydrated.path)
            DispatchQueue.main.async {
                guard let self, self.state != .stopping, self.state != .stopped else { return }
                self.log.note("PATH from \(hydrated.source): \(hydrated.path)")
                self.path = hydrated.path
                switch check {
                case .found(let node, let version):
                    self.log.note("Node.js \(version) at \(node)")
                    self.node = node
                    self.spawn(node: node)
                case .tooOld(let node, let version):
                    self.log.note("Node.js \(version.isEmpty ? "of unknown version" : version) at \(node) is too old; the dashboard needs 22.18 or newer")
                    self.state = .needsNode
                case .missing:
                    self.log.note("no node on PATH; the dashboard needs Node.js 22.18 or newer")
                    self.state = .needsNode
                }
            }
        }
    }

    private func spawn(node: String) {
        let entry = serverEntry(environment: environment, resources: Bundle.main.resourceURL)
        guard FileManager.default.fileExists(atPath: entry) else {
            // Nothing changes this short of a rebuild, so it isn't retried.
            log.note("there is no dashboard at \(entry): build the app with --server, or set DAILY_FOCUS_APP_SERVER_ENTRY")
            state = .blocked("This build of the app has no dashboard in it")
            return
        }
        let helper = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/Daily Focus Calendar.app").path
        let child = Process()
        child.executableURL = URL(fileURLWithPath: node)
        child.arguments = [entry, "--no-open"]
        child.environment = childEnvironment(
            environment,
            path: path ?? environment["PATH"] ?? "",
            calendarHelper: FileManager.default.fileExists(atPath: helper) ? helper : nil
        )
        // A relative path in a setting means the same as it would from a fresh Terminal.
        child.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        child.standardInput = FileHandle.nullDevice
        // One pipe for both, so the log keeps the server's lines in the order it wrote them.
        let pipe = Pipe()
        child.standardOutput = pipe
        child.standardError = pipe
        let log = self.log
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            log.write(chunk)
            DispatchQueue.main.async { self?.read(chunk, from: child) }
        }
        child.terminationHandler = { [weak self] finished in
            let code = finished.terminationStatus
            let signalled = finished.terminationReason == .uncaughtSignal
            DispatchQueue.main.async { self?.exited(child, code: code, signalled: signalled) }
        }

        log.note("starting \(node) \(entry) --no-open")
        do {
            try child.run()
        } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            log.note("could not start Node: \(error.localizedDescription)")
            scheduleStart(showing: .restarting)
            return
        }
        process = child
        startedAt = Date()
        output = Data()
        rememberChild(child.processIdentifier, node: node)
        state = .starting
    }

    /// Looks for the line that says where the server listens. Every line, not just
    /// the first: a server that restarts itself in-process for new settings says it
    /// again, possibly with another port.
    private func read(_ chunk: Data, from child: Process) {
        guard child === process else { return }
        output.append(chunk)
        while let newline = output.firstIndex(of: 0x0A) {
            let line = String(decoding: output[output.startIndex..<newline], as: UTF8.self)
            output.removeSubrange(output.startIndex...newline)
            if let url = dashboardURL(fromLine: line) { state = .running(url) }
        }
        // A line that never ends is not the one being looked for.
        if output.count > 65_536 { output.removeAll() }
    }

    private func exited(_ child: Process, code: Int32, signalled: Bool) {
        guard child === process else { return }
        process = nil
        forgetChild()
        let uptime = Date().timeIntervalSince(startedAt)
        log.note(signalled ? "the dashboard was stopped by signal \(code)" : "the dashboard exited with code \(code)")
        if stopRequested {
            stopRequested = false
            state = .stopped
            let done = whenStopped
            whenStopped = nil
            done?()
            return
        }
        if restartRequested {
            restartRequested = false
            probeThenSpawn()
            return
        }
        // Exit 0 is how the server answers SIGTERM, so a clean exit the app didn't
        // ask for was asked for by someone else, and the app is here to keep it up.
        attempt = restartAttempt(previous: attempt, uptime: uptime)
        scheduleStart(showing: .restarting)
    }

    private func scheduleStart(showing waiting: State) {
        let delay = restartDelay(attempt: attempt)
        attempt += 1
        log.note("trying again in \(Int(delay)) s")
        state = waiting
        let work = DispatchWorkItem { [weak self] in self?.probeThenSpawn() }
        pendingStart = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// SIGTERM, which the server answers by closing cleanly; SIGKILL if it hasn't
    /// within five seconds, because a quit that never finishes is worse.
    private func terminate(_ child: Process) {
        let pid = child.processIdentifier
        child.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, self.process === child, child.isRunning else { return }
            self.log.note("the dashboard didn't stop within 5 s; killing it")
            kill(pid, SIGKILL)
        }
    }

    private func rememberChild(_ pid: pid_t, node: String) {
        guard let running = runningProcess(pid) else { return }
        UserDefaults.standard.set(Int(pid), forKey: childPIDKey)
        UserDefaults.standard.set(realPath(node), forKey: childNodeKey)
        UserDefaults.standard.set(running.started, forKey: childStartKey)
    }

    private func forgetChild() {
        for key in [childPIDKey, childNodeKey, childStartKey] {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
}
