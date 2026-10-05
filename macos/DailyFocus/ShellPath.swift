// The PATH the dashboard runs with, and the Node.js on it.
//
// A GUI app starts with launchd's PATH, /usr/bin:/bin:/usr/sbin:/sbin, which has
// none of node, claude, gh or acli on it. The user's shell knows where they are,
// so the app asks it once, the way T3 Code does: an interactive login shell, so
// that both the profile and the rc files run, printing PATH between two markers.
// The markers are there because those files may print anything first (a greeting,
// a version manager's chatter), and none of it belongs in PATH.

import Darwin
import Foundation

let pathStartMarker = "__DF_PATH_START__"
let pathEndMarker = "__DF_PATH_END__"

/// The oldest Node.js the server runs on, as `package.json` says.
let minimumNode = [22, 18, 0]

/// The PATH a shell printed between the markers, or nil when it didn't print both.
func pathBetweenMarkers(_ output: String) -> String? {
    guard let start = output.range(of: pathStartMarker),
          let end = output.range(of: pathEndMarker, range: start.upperBound..<output.endIndex)
    else { return nil }
    let path = output[start.upperBound..<end.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
    return path.isEmpty ? nil : path
}

/// The shell's entries first, then the app's own, then the two places Node.js
/// installers put it, each once. The fallbacks are last so that a version manager's
/// Node, which only the shell knows about, wins over an older one installed globally.
func mergedPath(shellPath: String?, ownPath: String?) -> String {
    var entries: [String] = []
    for source in [shellPath, ownPath] {
        for entry in (source ?? "").split(separator: ":").map(String.init) where !entry.isEmpty && !entries.contains(entry) {
            entries.append(entry)
        }
    }
    for fallback in ["/opt/homebrew/bin", "/usr/local/bin"] where !entries.contains(fallback) {
        entries.append(fallback)
    }
    return entries.joined(separator: ":")
}

/// The shells to ask, in order: the one the environment names, the account's login
/// shell, and zsh, which every Mac has.
func shellCandidates(environment: [String: String], accountShell: String? = currentAccountShell()) -> [String] {
    var shells: [String] = []
    if let shell = environment["SHELL"], !shell.isEmpty { shells.append(shell) }
    if let accountShell, !accountShell.isEmpty { shells.append(accountShell) }
    shells.append("/bin/zsh")
    var seen: Set<String> = []
    return shells.filter { seen.insert($0).inserted }
}

/// The login shell the user account has, from the directory services.
func currentAccountShell() -> String? {
    guard let account = getpwuid(getuid()), let shell = account.pointee.pw_shell else { return nil }
    return String(cString: shell)
}

/// Collects a child's output from whatever thread the pipe delivers it on.
final class OutputBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func append(_ more: Data) {
        lock.lock()
        data.append(more)
        lock.unlock()
    }

    var text: String {
        lock.lock()
        defer { lock.unlock() }
        return String(decoding: data, as: UTF8.self)
    }
}

/// Runs a command with stdin from /dev/null and returns what it printed to stdout,
/// or nil when it could not be started at all.
///
/// It returns what it has after `timeout` seconds, and as soon as `marker` has been
/// printed when there is one, rather than waiting for the end of the output: an
/// interactive shell can leave a background job behind that holds the pipe open
/// long after the shell itself is done.
///
/// The command runs in a session of its own, with no terminal. An interactive shell
/// started with the terminal the app was run from makes itself that terminal's
/// foreground, and doesn't give it back to the app when it exits, so Ctrl-C no
/// longer reached the app. Process can't start a session, so this uses posix_spawn.
func output(of executable: String, _ arguments: [String], environment: [String: String]? = nil,
            timeout: TimeInterval, stopAfter marker: String? = nil) -> String? {
    var ends: [Int32] = [0, 0]
    guard pipe(&ends) == 0 else { return nil }
    let (readEnd, writeEnd) = (ends[0], ends[1])

    var actions: posix_spawn_file_actions_t?
    posix_spawn_file_actions_init(&actions)
    defer { posix_spawn_file_actions_destroy(&actions) }
    posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_adddup2(&actions, writeEnd, 1)
    posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)

    var attributes: posix_spawnattr_t?
    posix_spawnattr_init(&attributes)
    defer { posix_spawnattr_destroy(&attributes) }
    // Nothing but those three is inherited: not the app's other pipes, not its log.
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT))

    let argv = ([executable] + arguments).map { strdup($0) } + [nil]
    let envp = environment.map { $0.map { strdup("\($0.key)=\($0.value)") } + [nil] }
    defer {
        argv.forEach { free($0) }
        envp?.forEach { free($0) }
    }
    var pid: pid_t = 0
    let started = envp.map { posix_spawn(&pid, executable, &actions, &attributes, argv, $0) }
        ?? posix_spawn(&pid, executable, &actions, &attributes, argv, environ)
    close(writeEnd)
    guard started == 0 else {
        close(readEnd)
        return nil
    }

    let buffer = OutputBuffer()
    let done = DispatchSemaphore(value: 0)
    let reader = FileHandle(fileDescriptor: readEnd, closeOnDealloc: true)
    reader.readabilityHandler = { handle in
        let chunk = handle.availableData
        if chunk.isEmpty {
            handle.readabilityHandler = nil
            done.signal()
            return
        }
        buffer.append(chunk)
        if let marker, buffer.text.contains(marker) { done.signal() }
    }
    _ = done.wait(timeout: .now() + timeout)
    reader.readabilityHandler = nil
    // The whole session, which is the shell and anything it left running. An
    // interactive shell ignores SIGTERM, and by now nothing it could still say is wanted.
    kill(-pid, SIGKILL)
    var status: Int32 = 0
    waitpid(pid, &status, 0)
    return buffer.text
}

/// The PATH for the dashboard, and where it came from, for the log.
func hydratedPath(environment: [String: String]) -> (path: String, source: String) {
    let script = "printf '%s\\n' '\(pathStartMarker)'; printenv PATH || true; printf '%s\\n' '\(pathEndMarker)'"
    for shell in shellCandidates(environment: environment) where FileManager.default.isExecutableFile(atPath: shell) {
        if let printed = output(of: shell, ["-ilc", script], environment: environment, timeout: 5, stopAfter: pathEndMarker),
           let path = pathBetweenMarkers(printed) {
            return (mergedPath(shellPath: path, ownPath: environment["PATH"]), shell)
        }
    }
    // launchd's own PATH is what the user may have set with `launchctl setenv`, which
    // is still better than nothing when every shell failed to answer.
    if let printed = output(of: "/bin/launchctl", ["getenv", "PATH"], timeout: 5) {
        let path = printed.trimmingCharacters(in: .whitespacesAndNewlines)
        if !path.isEmpty { return (mergedPath(shellPath: path, ownPath: environment["PATH"]), "launchctl") }
    }
    return (mergedPath(shellPath: nil, ownPath: environment["PATH"]), "the app's own environment")
}

/// The first executable called `name` on `path`, the way a shell would find it.
func findExecutable(_ name: String, on path: String) -> String? {
    for directory in path.split(separator: ":") where directory.hasPrefix("/") {
        let candidate = "\(directory)/\(name)"
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: candidate, isDirectory: &isDirectory), !isDirectory.boolValue,
           FileManager.default.isExecutableFile(atPath: candidate) {
            return candidate
        }
    }
    return nil
}

/// "v22.18.0" as [22, 18, 0]. A pre-release or build suffix is ignored.
func versionNumbers(_ text: String) -> [Int]? {
    var version = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if version.hasPrefix("v") { version.removeFirst() }
    guard let core = version.split(whereSeparator: { $0 == "-" || $0 == "+" }).first else { return nil }
    let parts = core.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
    guard !parts.isEmpty, !parts.contains(where: { $0 == nil }) else { return nil }
    return parts.map { $0! }
}

/// Whether `node --version` printed a version the server runs on.
func isSupportedNode(_ version: String) -> Bool {
    guard let numbers = versionNumbers(version) else { return false }
    for (have, need) in zip(numbers + [0, 0, 0], minimumNode) where have != need {
        return have > need
    }
    return true
}

enum NodeCheck: Equatable {
    case found(path: String, version: String)
    case tooOld(path: String, version: String)
    case missing
}

/// The first `node` on `path`, as a shell would pick it.
func checkNode(on path: String) -> NodeCheck {
    guard let node = findExecutable("node", on: path) else { return .missing }
    let version = (output(of: node, ["--version"], timeout: 5) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return isSupportedNode(version) ? .found(path: node, version: version) : .tooOld(path: node, version: version)
}

/// The Node.js the dashboard runs on: the one this app carries, so it needs nothing
/// installed and runs on the version it was built with. The first `node` on `path`
/// is the fallback, for a development build without one, or a macOS too old for
/// the one it carries, which then fails to answer `--version`.
func chooseNode(bundled: String?, path: String) -> NodeCheck {
    if let bundled, FileManager.default.isExecutableFile(atPath: bundled) {
        let version = (output(of: bundled, ["--version"], timeout: 5) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if isSupportedNode(version) { return .found(path: bundled, version: version) }
    }
    return checkNode(on: path)
}

/// `path` with `directory` last, unless it is on it already. The dashboard runs the
/// agents' CLIs, and one installed with npm starts with `#!/usr/bin/env node`: with
/// the folder of the Node this app carries at the end of the PATH, such a CLI runs
/// even on a Mac with no Node of its own, while one the user installed still wins.
func appendingToPath(_ path: String, _ directory: String?) -> String {
    guard let directory, !directory.isEmpty else { return path }
    let entries = path.split(separator: ":").map(String.init)
    if entries.contains(directory) { return path }
    return (entries + [directory]).joined(separator: ":")
}
