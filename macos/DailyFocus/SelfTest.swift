// `Daily Focus --self-test`: assertions over the logic that doesn't need a menu, a
// dashboard or a person to click, run by `macos/build.sh --test`. Plain checks
// rather than XCTest, because the app is built with swiftc alone.

import Foundation

func runSelfTest() -> Bool {
    var checks = 0
    var failures = 0
    func check(_ condition: Bool, _ what: String) {
        checks += 1
        if !condition {
            failures += 1
            print("FAIL \(what)")
        }
    }
    func equal<T: Equatable>(_ actual: T, _ expected: T, _ what: String) {
        check(actual == expected, "\(what): expected \(expected), got \(actual)")
    }

    // PATH between the markers, whatever the shell's startup files print around it.
    let noisy = "Welcome back!\nnvm: using node 24\n__DF_PATH_START__\n/Users/x/.nvm/bin:/usr/bin\n__DF_PATH_END__\nbye\n"
    equal(pathBetweenMarkers(noisy), "/Users/x/.nvm/bin:/usr/bin", "path between markers")
    equal(pathBetweenMarkers("__DF_PATH_START__\r\n/usr/bin\r\n__DF_PATH_END__\r\n"), "/usr/bin", "path with CRLF")
    equal(pathBetweenMarkers("__DF_PATH_START__\n/usr/bin\n"), nil, "path without an end marker")
    equal(pathBetweenMarkers("__DF_PATH_START__\n\n__DF_PATH_END__\n"), nil, "empty path")
    equal(pathBetweenMarkers("__DF_PATH_END__\n/usr/bin\n__DF_PATH_START__\n"), nil, "markers in the wrong order")

    equal(
        mergedPath(shellPath: "/Users/x/.nvm/bin:/usr/bin::/bin", ownPath: "/usr/bin:/bin:/usr/sbin:/sbin"),
        "/Users/x/.nvm/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
        "merged path"
    )
    equal(
        mergedPath(shellPath: "/usr/local/bin:/opt/homebrew/bin", ownPath: "/usr/bin"),
        "/usr/local/bin:/opt/homebrew/bin:/usr/bin",
        "merged path keeps the shell's order for the fallbacks"
    )
    equal(mergedPath(shellPath: nil, ownPath: nil), "/opt/homebrew/bin:/usr/local/bin", "merged path from nothing")
    // The account's shell is passed in, since the real one differs from Mac to Mac:
    // bash on a CI runner, zsh on most desktops.
    equal(
        shellCandidates(environment: ["SHELL": "/opt/homebrew/bin/fish"], accountShell: "/bin/bash"),
        ["/opt/homebrew/bin/fish", "/bin/bash", "/bin/zsh"],
        "SHELL first, then the account's shell, then zsh as the last resort"
    )
    equal(
        shellCandidates(environment: ["SHELL": "/bin/zsh"], accountShell: "/bin/zsh").filter { $0 == "/bin/zsh" }.count,
        1,
        "shells are asked once"
    )
    equal(shellCandidates(environment: [:], accountShell: nil), ["/bin/zsh"], "zsh when nothing else is known")

    // A command runs as the leader of a session of its own (`s` in its state), so an
    // interactive shell has no terminal to take from the one the app was run from.
    let state = output(of: "/bin/sh", ["-c", "ps -o stat= -p $$"], timeout: 5) ?? ""
    check(state.contains("s"), "a command runs in a session of its own: state \(state.debugDescription)")
    equal(output(of: "/usr/bin/printenv", ["ANSWER"], environment: ["ANSWER": "42"], timeout: 5), "42\n", "a command gets the environment it is given")
    let begun = Date()
    equal(output(of: "/bin/sh", ["-c", "echo early; echo __DF_PATH_END__; sleep 30 & wait"], timeout: 10, stopAfter: "__DF_PATH_END__"),
          "early\n__DF_PATH_END__\n", "output up to the marker")
    check(Date().timeIntervalSince(begun) < 5, "the marker ends the wait, and what was left running is stopped")
    equal(output(of: "/nonexistent/command", [], timeout: 5), nil, "a command that can't start")

    // Node versions.
    equal(versionNumbers("v22.18.0\n"), [22, 18, 0], "version numbers")
    equal(versionNumbers("v23.0.0-nightly2026"), [23, 0, 0], "pre-release version")
    equal(versionNumbers("garbage"), nil, "not a version")
    equal(versionNumbers(""), nil, "empty version")
    for (version, supported) in [
        ("v22.18.0", true), ("v22.17.9", false), ("v22.18", true), ("v24.0.0", true), ("v26.10.0", true),
        ("v21.99.99", false), ("v100.0.0", true), ("v18.20.4", false), ("", false), ("node", false),
    ] {
        equal(isSupportedNode(version), supported, "Node \(version.isEmpty ? "(none)" : version) supported")
    }

    // Restarts.
    equal((0..<7).map { restartDelay(attempt: $0) }, [1, 2, 5, 10, 30, 30, 30], "backoff schedule")
    equal(restartAttempt(previous: 4, uptime: 59), 4, "backoff kept after a short run")
    equal(restartAttempt(previous: 4, uptime: 60), 0, "backoff reset after a minute up")

    // Where the server says it listens.
    equal(dashboardURL(fromLine: "[daily-focus] dashboard  http://127.0.0.1:4321"), URL(string: "http://127.0.0.1:4321"), "dashboard line")
    equal(dashboardURL(fromLine: "[daily-focus] dashboard  http://127.0.0.1:4396\r"), URL(string: "http://127.0.0.1:4396"), "dashboard line with CR")
    equal(dashboardURL(fromLine: "[daily-focus] dashboard  http://0.0.0.0:4321"), URL(string: "http://127.0.0.1:4321"), "wildcard bind")
    equal(dashboardURL(fromLine: "[daily-focus] dashboard  http://:::4321"), URL(string: "http://127.0.0.1:4321"), "IPv6 wildcard bind")
    equal(dashboardURL(fromLine: "[daily-focus] dashboard  http://100.64.1.2:4321"), URL(string: "http://100.64.1.2:4321"), "a named address")
    equal(dashboardURL(fromLine: "[daily-focus] store      /tmp/x"), nil, "store line")
    equal(dashboardURL(fromLine: "[daily-focus] dashboard  http://127.0.0.1"), nil, "no port")
    equal(dashboardURL(fromLine: "listening on http://127.0.0.1:4321"), nil, "someone else's line")

    equal(probePort([:]), 4321, "default port")
    equal(probePort(["DAILY_FOCUS_PORT": "4396"]), 4396, "configured port")
    equal(probePort(["DAILY_FOCUS_PORT": "0"]), nil, "any free port can't be probed")
    equal(probePort(["DAILY_FOCUS_PORT": "nope"]), 4321, "unreadable port")

    equal(serverEntry(environment: ["DAILY_FOCUS_APP_SERVER_ENTRY": "/src/server.ts"], resources: nil), "/src/server.ts", "development entry")
    equal(
        serverEntry(environment: [:], resources: URL(fileURLWithPath: "/Applications/Daily Focus.app/Contents/Resources")),
        "/Applications/Daily Focus.app/Contents/Resources/server/dist/cli.js",
        "bundled entry"
    )

    let child = childEnvironment(["PATH": "/usr/bin", "HOME": "/Users/x", "DAILY_FOCUS_DATA": "/mine"], path: "/a:/b")
    equal(child["PATH"], "/a:/b", "child PATH")
    equal(child["HOME"], "/Users/x", "child keeps the rest")
    equal(child["DAILY_FOCUS_DATA"], "/mine", "a store the user named is passed on as it is")
    equal(childEnvironment([:], path: "")["DAILY_FOCUS_CALENDAR_APP"], nil, "the app's own helper is the dashboard's to find")

    // Where to look for a dashboard already running.
    equal(probeURL([:])?.absoluteString, "http://127.0.0.1:4321", "loopback by default")
    equal(probeURL(["DAILY_FOCUS_HOST": "::1", "DAILY_FOCUS_PORT": "4396"])?.absoluteString, "http://[::1]:4396", "IPv6 bracketed")
    equal(probeURL(["DAILY_FOCUS_HOST": "0.0.0.0"])?.absoluteString, "http://127.0.0.1:4321", "a wildcard is looked for on loopback")
    equal(probeURL(["DAILY_FOCUS_HOST": "::"])?.absoluteString, "http://[::1]:4321", "an IPv6 wildcard too")
    equal(probeURL(["DAILY_FOCUS_HOST": "100.99.1.2"])?.absoluteString, "http://100.99.1.2:4321", "a named address as it is")
    equal(probeURL(["DAILY_FOCUS_PORT": "0"]), nil, "no telling where any free port is")

    // The Node.js this app carries goes last on the dashboard's PATH, once.
    let helpers = "/Applications/Daily Focus.app/Contents/Helpers"
    equal(appendingToPath("/opt/homebrew/bin:/usr/bin", helpers), "/opt/homebrew/bin:/usr/bin:\(helpers)", "bundled Node is the last resort")
    equal(appendingToPath("/usr/bin:\(helpers)", helpers), "/usr/bin:\(helpers)", "and is added only once")
    equal(appendingToPath("/usr/bin", nil), "/usr/bin", "a build without one changes nothing")
    equal(chooseNode(bundled: "/nonexistent/node", path: ""), .missing, "a bundled Node that isn't there falls back to PATH")

    // The status line.
    let json = """
    {"dataDir":"/Users/x/.daily-focus","profile":"work","setupNeeded":false,"restartPending":false,
     "brief":{"generatedAt":"2026-10-04T05:10:00.000Z","ageHours":3,"stale":false,"open":7},
     "agent":{"enabled":true,"running":false,"nextRunAt":null,
              "last":{"id":"r1","status":"done","startedAt":"2026-10-04T05:00:00.000Z","endedAt":"2026-10-04T05:10:00.000Z","error":null}},
     "waitingOnYou":0}
    """
    let decoded = try? JSONDecoder().decode(DashboardStatus.self, from: Data(json.utf8))
    check(decoded != nil, "status decodes")
    let base = decoded ?? DashboardStatus()
    let now = parseDate("2026-10-04T08:10:00Z")!
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(identifier: "UTC")!
    let posix = Locale(identifier: "en_US_POSIX")
    func line(_ status: DashboardStatus, at time: Date = now) -> String {
        // Recent ICU puts a narrow no-break space before AM; the words are what is being checked.
        statusLine(status, now: time, calendar: utc, locale: posix).replacingOccurrences(of: "\u{202F}", with: " ")
    }

    equal(line(base), "Brief updated 3 hours ago · 7 open", "fresh brief")
    check(!needsAttention(base), "a fresh brief needs no attention")

    var waiting = base
    waiting.waitingOnYou = 2
    equal(line(waiting), "Brief updated 3 hours ago · 7 open · 2 waiting on you", "pull requests waiting")

    var stale = base
    stale.brief?.stale = true
    equal(line(stale, at: parseDate("2026-10-06T08:10:00Z")!), "Brief out of date, updated 2 days ago · 7 open", "stale brief")
    check(needsAttention(stale), "a stale brief needs attention")

    var running = base
    running.agent?.running = true
    equal(line(running), "The morning agent is writing a brief…", "agent running")

    var failed = base
    failed.agent?.last = .init(id: "r2", status: "failed", startedAt: "2026-10-04T07:00:00Z", endedAt: "2026-10-04T07:12:00Z", error: "codex exited 1")
    equal(line(failed), "The morning agent failed at 7:12 AM", "failed run today")
    equal(line(failed, at: parseDate("2026-10-05T09:00:00Z")!), "The morning agent failed yesterday at 7:12 AM", "failed run yesterday")
    equal(line(failed, at: parseDate("2026-10-08T09:00:00Z")!), "The morning agent failed on Oct 4 at 7:12 AM", "failed run last week")
    check(needsAttention(failed), "a failed run needs attention")

    var recovered = failed
    recovered.brief?.generatedAt = "2026-10-04T07:30:00Z"
    equal(line(recovered), "Brief updated 40 minutes ago · 7 open", "a brief written after the failure")
    check(!needsAttention(recovered), "a failure followed by a brief needs no attention")

    var fresh = DashboardStatus()
    fresh.setupNeeded = true
    fresh.brief = .init(generatedAt: nil, ageHours: nil, stale: false, open: 0)
    equal(line(fresh), "No brief yet — finish setup in the dashboard", "first run")
    check(needsAttention(fresh), "setup needs attention")
    fresh.setupNeeded = false
    equal(line(fresh), "No brief yet", "no brief, set up")

    var settings = base
    settings.restartPending = true
    equal(line(settings), "Restarting to apply new settings…", "restart pending")

    let nulls = #"{"brief":{"generatedAt":null,"ageHours":null,"stale":false,"open":0},"agent":{"enabled":false,"running":false,"nextRunAt":null,"last":null}}"#
    let sparse = try? JSONDecoder().decode(DashboardStatus.self, from: Data(nulls.utf8))
    check(sparse != nil, "status with nulls decodes")
    equal(sparse?.agent?.last, nil, "no last run")

    equal(ago(now, now: now), "just now", "just now")
    equal(ago(now.addingTimeInterval(-60), now: now), "a minute ago", "a minute")
    equal(ago(now.addingTimeInterval(-3_599), now: now), "59 minutes ago", "minutes")
    equal(ago(now.addingTimeInterval(-3_600), now: now), "an hour ago", "an hour")
    equal(ago(now.addingTimeInterval(-47 * 3_600), now: now), "47 hours ago", "hours")
    equal(ago(now.addingTimeInterval(-50 * 3_600), now: now), "2 days ago", "days")
    equal(ago(now.addingTimeInterval(60), now: now), "just now", "a clock that runs ahead")
    equal(parseDate("2026-10-04T05:10:00Z"), parseDate("2026-10-04T05:10:00.000Z"), "dates with and without milliseconds")

    // Notifications.
    let briefAt = parseDate("2026-10-04T05:10:00.000Z")!
    var first = notices(for: base, after: Notified(), firstPoll: true)
    equal(first.notices, [], "nothing on the first poll")
    equal(first.notified.briefAt, briefAt, "the first poll takes note of the brief")
    var newer = base
    newer.brief?.generatedAt = "2026-10-05T05:10:00.000Z"
    let next = notices(for: newer, after: first.notified, firstPoll: false)
    equal(next.notices, [.briefReady(open: 7)], "a newer brief")
    equal(notices(for: newer, after: next.notified, firstPoll: false).notices, [], "the same brief twice")
    equal(notices(for: base, after: next.notified, firstPoll: false).notices, [], "an older brief")
    equal(notices(for: newer, after: first.notified, firstPoll: true).notices, [], "a newer brief on the first poll")

    first = notices(for: failed, after: Notified(briefAt: briefAt), firstPoll: true)
    equal(first.notices, [], "a failure on the very first launch is history")
    equal(first.notified.failedRunId, "r2", "and is noted")
    equal(notices(for: failed, after: Notified(briefAt: briefAt), firstPoll: false).notices,
          [.agentFailed(error: "codex exited 1")], "a failure")
    equal(notices(for: failed, after: first.notified, firstPoll: false).notices, [], "the same failure twice")
    equal(notices(for: failed, after: Notified(briefAt: briefAt, failedRunId: "r1"), firstPoll: true).notices,
          [.agentFailed(error: "codex exited 1")], "a failure while the app wasn't looking")
    var aborted = failed
    aborted.agent?.last?.status = "aborted"
    equal(notices(for: aborted, after: Notified(briefAt: briefAt), firstPoll: false).notices, [], "a stopped run is no failure")

    equal(noticeText(.briefReady(open: 7)).body, "7 open items", "notice body")
    equal(noticeText(.briefReady(open: 1)).body, "1 open item", "notice body, one item")
    equal(noticeText(.agentFailed(error: "  ")).body, "Open Daily Focus to see what it said.", "failure without a reason")

    equal(errorMessage(Data(#"{"error":"the morning agent is off"}"#.utf8)), "the morning agent is off", "refusal reason")
    equal(errorMessage(Data("<html>".utf8)), nil, "not JSON")
    check(isDashboardHealth(Data(#"{"ok":true,"dataDir":"/tmp/x"}"#.utf8)), "a dashboard's health")
    check(!isDashboardHealth(Data(#"{"status":"ok"}"#.utf8)), "someone else's health")
    check(!isDashboardHealth(Data(#"{"ok":true}"#.utf8)), "ok, but not a dashboard: no store")

    // Updates: versions in semver's order.
    let ordered = ["0.0.0-development", "0.1.0", "0.1.1-dev.2", "0.1.1-dev.10", "0.1.1", "0.2.0-alpha", "0.2.0-dev.1", "0.2.0", "1.0.0"]
    let versions = ordered.compactMap(Version.init)
    equal(versions.count, ordered.count, "versions parse")
    equal(versions.map(\.description), versions.sorted().map(\.description), "semver order")
    check(Version("0.1.1-dev.9")! < Version("0.1.1-dev.10")!, "pre-release numbers compare as numbers")
    check(Version("1.0.0-dev.1")! < Version("1.0.0-dev.a")!, "numbers before words")
    check(Version("0.2.0+build.5")! == Version("0.2.0")!, "build metadata doesn't count")
    for bad in ["", "1.2", "1.2.3.4", "v1.2.3", "1.2.x", "1.2.3-", "1.2.3-dev..1", "1.2.3-../x", "1.2.3-a/b", " 1.2.3", "１.2.3"] {
        check(Version(bad) == nil, "not a version: \(bad.debugDescription)")
    }
    equal(Track.of(appVersion: "0.2.0"), .stable, "a stable app starts on stable releases")
    equal(Track.of(appVersion: "0.2.1-dev.4"), .development, "a development build on development builds")
    equal(Track.of(appVersion: "0.0.0-development"), .development, "a checkout's build too")
    equal(Track.stable.distTag, "latest", "stable is npm's latest")
    equal(Track.development.distTag, "dev", "development is npm's dev")
    equal(manifestURL(.development, environment: [:]).absoluteString, "https://registry.npmjs.org/daily-focus/dev", "where releases are looked up")
    equal(downloadURL("0.2.0", asset: dashboardAsset, environment: [:]).absoluteString,
          "https://github.com/watson/daily-focus/releases/download/v0.2.0/Daily-Focus-Dashboard.zip", "where a dashboard is fetched")
    equal(downloadURL("0.2.0", asset: appAsset, environment: [:]).absoluteString,
          "https://github.com/watson/daily-focus/releases/download/v0.2.0/Daily-Focus-App.zip", "where an app is fetched")
    let local = ["DAILY_FOCUS_APP_UPDATES": "http://127.0.0.1:9000/feed"]
    equal(manifestURL(.stable, environment: local).absoluteString, "http://127.0.0.1:9000/feed/daily-focus/latest", "a local feed")
    equal(downloadURL("0.2.0", asset: appAsset, environment: local).absoluteString, "http://127.0.0.1:9000/feed/v0.2.0/Daily-Focus-App.zip", "and its downloads")

    // What this app can run.
    for (range, node, fits) in [
        (">=22.18", "v24.21.0", true), (">=22.18", "v22.18.0", true), (">=22.18", "v22.17.1", false),
        (">=26", "v24.21.0", false), (" >= 24.1 ", "v24.1.0", true), ("^22.18", "v24.21.0", false), ("", "v24.21.0", true),
    ] {
        equal(nodeSatisfies(range, version: node), fits, "Node \(node) for \(range.debugDescription)")
    }
    let current = Manifest(version: "0.3.0", engines: .init(node: ">=22.18"), app: .init(appInterface: appInterface, appSource: "aaa"))
    var demanding = current
    demanding.app?.appInterface = appInterface + 1
    var newNode = current
    newNode.engines?.node = ">=99"
    equal(appShortfall(current, nodeVersion: "v24.21.0"), nil, "a dashboard this app runs")
    equal(appShortfall(demanding, nodeVersion: "v24.21.0"), "it needs a newer version of the app", "one that needs more of the app")
    check(appShortfall(newNode, nodeVersion: "v24.21.0") != nil, "one that needs a newer Node")
    equal(appShortfall(Manifest(version: "0.3.0"), nodeVersion: nil), nil, "one that asks for nothing")

    // Which downloaded dashboard runs.
    func downloaded(_ manifest: Manifest) -> (copy: DashboardCopy, manifest: Manifest) {
        (DashboardCopy(version: manifest.version, entry: "/d/\(manifest.version)/cli.js", bundle: "/d/\(manifest.version)"), manifest)
    }
    var older = current
    older.version = "0.1.0"
    var newest = current
    newest.version = "0.4.0-dev.2"
    var unrunnable = demanding
    unrunnable.version = "0.5.0"
    let found = [downloaded(older), downloaded(newest), downloaded(current), downloaded(unrunnable)]
    equal(dashboardCandidates(bundled: "0.2.0", downloaded: found, refused: [], nodeVersion: "v24.21.0").map(\.version),
          ["0.4.0-dev.2", "0.3.0"], "newest first, none older than the app's own, none the app can't run")
    equal(dashboardCandidates(bundled: "0.2.0", downloaded: found, refused: ["0.4.0-dev.2"], nodeVersion: "v24.21.0").map(\.version),
          ["0.3.0"], "not one that failed to start")
    equal(dashboardCandidates(bundled: "0.4.0", downloaded: found, refused: [], nodeVersion: "v24.21.0").map(\.version),
          [], "a newer app's own copy beats every download")
    var misnamed = downloaded(current)
    misnamed.copy.version = "0.9.0"
    equal(dashboardCandidates(bundled: "0.2.0", downloaded: [misnamed], refused: [], nodeVersion: nil).map(\.version),
          [], "a folder that says another version than its package")

    // What is offered: the app when its code changed and it can put the new one in
    // its own place, else the dashboard alone, with a link to the app's disk image.
    func offered(_ latest: Manifest, running: String?, app: String = "0.2.0", source: String? = "aaa", replaces: Bool = true) -> Offer {
        offer(latest: latest, running: running, appVersion: app, appSource: source, nodeVersion: "v24.21.0", canReplaceApp: replaces)
    }
    equal(offered(current, running: "0.2.0"), Offer(update: .dashboard("0.3.0")), "a newer dashboard")
    equal(offered(current, running: "0.2.0", replaces: false), Offer(update: .dashboard("0.3.0")),
          "a newer dashboard, whether or not the app could replace itself")
    equal(offered(current, running: "0.3.0"), Offer(), "nothing newer")
    equal(offered(older, running: "0.2.0"), Offer(), "nothing older, after a change of track")
    equal(offered(current, running: nil), Offer(), "no dashboard for a checkout, or for one another process runs")
    equal(offered(demanding, running: "0.2.0"), Offer(update: .app("0.3.0")), "a dashboard that needs a newer app brings the app")
    equal(offered(demanding, running: "0.2.0", replaces: false), Offer(download: "0.3.0"),
          "or links to it, when the app can't replace itself")
    equal(offered(current, running: "0.2.0", source: "bbb"), Offer(update: .app("0.3.0")), "a release whose app changed")
    equal(offered(current, running: "0.2.0", source: "bbb", replaces: false), Offer(update: .dashboard("0.3.0"), download: "0.3.0"),
          "its dashboard, and a link to its app, when the app can't replace itself")
    equal(offered(current, running: "0.3.0", source: "bbb"), Offer(update: .app("0.3.0")),
          "the app, after its dashboard came on its own")
    equal(offered(current, running: nil, source: "bbb"), Offer(update: .app("0.3.0")),
          "the app, though another process runs the dashboard")
    equal(offered(current, running: "0.3.0", app: "0.3.0", source: "bbb"), Offer(), "not this app's own release, whatever it says")
    equal(offered(current, running: "0.2.0", app: "0.0.0-development", source: nil), Offer(update: .dashboard("0.3.0")),
          "a checkout's build of the app is never told of a newer one")

    // Whether the app can replace itself where it is.
    let files = FileManager.default
    let scratch = files.temporaryDirectory.appendingPathComponent("daily-focus-self-test-\(UUID().uuidString)")
    defer { try? files.removeItem(at: scratch) }
    let apps = scratch.appendingPathComponent("Applications")
    let installed = apps.appendingPathComponent("Daily Focus.app")
    let staged = scratch.appendingPathComponent("Staging/Daily Focus.app")
    func put(_ text: String, in app: URL) {
        try? files.createDirectory(at: app.appendingPathComponent("Contents"), withIntermediateDirectories: true)
        try? Data(text.utf8).write(to: app.appendingPathComponent("Contents/which"))
    }
    func which(_ app: URL) -> String? {
        (try? Data(contentsOf: app.appendingPathComponent("Contents/which"))).map { String(decoding: $0, as: UTF8.self) }
    }
    put("old", in: installed)
    put("new", in: staged)
    equal(replacementProblem(bundle: installed, team: "TEAM"), nil, "an app in a folder this account can change")
    check(replacementProblem(bundle: installed, team: nil) != nil, "not one with no team to check a download against")
    let translocated = URL(fileURLWithPath: "/private/var/folders/x/T/AppTranslocation/ABC/d/Daily Focus.app")
    check(replacementProblem(bundle: translocated, team: "TEAM")?.contains("temporary copy") == true, "not one macOS runs from a temporary copy")
    try? files.setAttributes([.posixPermissions: 0o555], ofItemAtPath: apps.path)
    check(replacementProblem(bundle: installed, team: "TEAM")?.hasPrefix("this account can't change") == true,
          "not one in a folder this account can't change")
    try? files.setAttributes([.posixPermissions: 0o755], ofItemAtPath: apps.path)

    // The swap that puts a new app in place.
    check((try? putAppInPlace(installed: installed, staged: staged, version: "0.3.0", team: "TEAM")) == nil,
          "an app that doesn't check out isn't put in place")
    equal(which(installed), "old", "and is swapped back out")
    equal(which(staged), "new", "to where it was")
    check((try? swapFolders(staged, installed)) != nil, "two folders swap")
    equal([which(installed), which(staged)], ["new", "old"], "each into the other's place")
    check((try? swapFolders(scratch.appendingPathComponent("nothing"), installed)) == nil, "a swap with nothing to swap fails")
    equal(which(installed), "new", "and leaves what was there")

    // What the package says, as npm serves it.
    let served = #"{"name":"daily-focus","version":"0.3.0","engines":{"node":">=22.18"},"daily-focus":{"appInterface":\#(appInterface),"appSource":"aaa"},"dist":{}}"#
    equal(try? JSONDecoder().decode(Manifest.self, from: Data(served.utf8)), current, "manifest decodes")
    equal(try? JSONDecoder().decode(Manifest.self, from: Data(#"{"version":"0.1.0"}"#.utf8)), Manifest(version: "0.1.0"),
          "a manifest from before the app's fields")

    check(!isBusy(base), "an idle dashboard")
    var agentBusy = base
    agentBusy.agent?.running = true
    check(isBusy(agentBusy), "a dashboard from before busy, running the agent")
    var assistantBusy = base
    assistantBusy.busy = true
    check(isBusy(assistantBusy), "a dashboard that says it is busy")
    let current2 = try? JSONDecoder().decode(DashboardStatus.self, from: Data(#"{"version":"0.3.0","busy":true}"#.utf8))
    equal(current2?.version, "0.3.0", "status says its version")
    equal(current2?.busy, true, "and whether it is busy")

    // What a busy dashboard is busy with, for "once … is done" and "stops …".
    equal(busyWith(agentBusy), "the morning agent", "a dashboard from before busyWith, running the agent")
    equal(busyWith(assistantBusy), "the assistant", "and busy otherwise")
    var setupBusy = assistantBusy
    setupBusy.busyWith = ["setup"]
    equal(busyWith(setupBusy), "the setup screen", "the setup screen's sessions")
    setupBusy.busyWith = ["assistant", "setup"]
    equal(busyWith(setupBusy), "the assistant", "the assistant beside them")
    setupBusy.busyWith = ["agent"]
    equal(busyWith(setupBusy), "the morning agent", "the agent, by the list")

    // Updates that go in on their own: half an hour after anyone last used the
    // dashboard, and never while it is at work.
    let used = try? JSONDecoder().decode(DashboardStatus.self, from: Data(#"{"busy":false,"busyWith":[],"usedAt":"2026-10-04T07:40:00.000Z"}"#.utf8))
    equal(used?.usedAt, "2026-10-04T07:40:00.000Z", "status says when the dashboard was last used")
    equal(used?.busyWith, [], "and what it is busy with")
    check(!mayUpdateUnattended(base, now: now), "not with a dashboard that can't say when it was last used")
    var quiet = base
    quiet.usedAt = "2026-10-04T07:40:00.000Z"
    check(mayUpdateUnattended(quiet, now: now), "half an hour after it was last used")
    quiet.usedAt = "2026-10-04T07:41:00Z"
    check(!mayUpdateUnattended(quiet, now: now), "not a minute sooner")
    quiet.usedAt = "2026-10-04T06:00:00Z"
    quiet.busy = true
    check(!mayUpdateUnattended(quiet, now: now), "not while something is at work, however long ago it was used")
    equal(noticeText(.updateAvailable(version: "0.3.0")).title, "Daily Focus 0.3.0 is available", "update notice")
    equal(noticeText(.downloadAvailable(version: "0.3.0", reason: "it runs from the disk image it came in")).body,
          "Daily Focus can't replace itself, since it runs from the disk image it came in. Download it from the Daily Focus menu.",
          "a notice for an app to download")

    // Two dashboards, one per profile, in one data folder.
    equal(dataFolder([:], home: "/Users/x"), "/Users/x/.daily-focus", "the default data folder")
    equal(dataFolder(["DAILY_FOCUS_DATA": "~/notes/df/"], home: "/Users/x"), "/Users/x/notes/df", "a folder in home")
    equal(dataFolder(["DAILY_FOCUS_DATA": "df"], home: "/Users/x"), "/Users/x/df", "a relative folder, from home, where the app starts the dashboards")
    equal(dataFolder(["DAILY_FOCUS_DATA": " /tmp/x "], home: "/Users/x"), "/tmp/x", "an absolute folder")
    equal(firstSlot([:]), DashboardSlot(id: "first", profile: nil, port: 4321), "the first dashboard, before it has said its profile")
    equal(firstSlot(["DAILY_FOCUS_PORT": "0", "DAILY_FOCUS_PROFILE": "Personal"]), DashboardSlot(id: "first", profile: "personal", port: 0),
          "a development run's port and profile")
    equal(firstSlot(["DAILY_FOCUS_PROFILE": "home"]).profile, nil, "a profile that is neither is none")
    let work = DashboardSlot(id: "first", profile: "work", port: 4321)
    equal(profileToAdd([DashboardSlot(id: "first", profile: nil, port: 4321)]), nil, "nothing to add before the first has said what it is")
    equal(profileToAdd([work]), "personal", "the other profile")
    equal(profileToAdd([DashboardSlot(id: "first", profile: "personal", port: 4321)]), "work", "the other way round")
    equal(profileToAdd([work, DashboardSlot(id: "personal", profile: "personal", port: 4322)]), nil, "nothing beside two")
    equal(nextPort([work]), 4322, "the next port")
    equal(nextPort([DashboardSlot(id: "first", profile: "work", port: 0)]), 0, "any free one beside a dashboard on any")
    let started = slotEnvironment(["PATH": "/usr/bin", "DAILY_FOCUS_DATA": "/d", "DAILY_FOCUS_PROFILE": "work"],
                                  DashboardSlot(id: "personal", profile: "personal", port: 4322))
    equal(started["DAILY_FOCUS_PROFILE"], "personal", "a dashboard is told its profile")
    equal(started["DAILY_FOCUS_PORT"], "4322", "and its port")
    equal(started["DAILY_FOCUS_DATA"], "/d", "and the data folder is the app's")
    equal(slotEnvironment(["DAILY_FOCUS_PROFILE": "work"], DashboardSlot(id: "first", profile: nil, port: 4321))["DAILY_FOCUS_PROFILE"], nil,
          "one that hasn't said is told none, and opens whichever store is there")
    check(servesStore("/d/work", folder: "/d", profile: "work"), "the profile's store is this dashboard's")
    check(!servesStore("/d/personal", folder: "/d", profile: "work"), "the other profile's isn't")
    check(!servesStore("/elsewhere/work", folder: "/d", profile: "work"), "nor one in another folder")
    check(servesStore("/d", folder: "/d", profile: nil), "before it knows its profile, a store from before the folders is")
    check(servesStore("/d/personal", folder: "/d/", profile: nil), "and so is either profile's")
    check(!servesStore(nil, folder: "/d", profile: nil), "a dashboard that doesn't say isn't")
    equal(keySuffix(work), "", "the first dashboard keeps the keys an app from before the list used")
    equal(keySuffix(DashboardSlot(id: "personal", profile: "personal", port: 4322)), ".personal", "another has its own")
    if let defaults = UserDefaults(suiteName: "dk.tson.daily-focus.self-test.\(getpid())") {
        equal(savedSlots(folder: "/d", environment: [:], defaults: defaults), [DashboardSlot(id: "first", profile: nil, port: 4321)],
              "with nothing saved, one dashboard")
        saveSlots([work, DashboardSlot(id: "personal", profile: "personal", port: 4322)], folder: "/d", defaults: defaults)
        equal(savedSlots(folder: "/d", environment: [:], defaults: defaults).map(\.id), ["first", "personal"], "the list is kept")
        equal(savedSlots(folder: "/tmp/other", environment: [:], defaults: defaults).count, 1, "per data folder")
        defaults.removePersistentDomain(forName: "dk.tson.daily-focus.self-test.\(getpid())")
    }
    func copy(_ version: String, downloaded: Bool = true) -> DashboardCopy {
        DashboardCopy(version: version, entry: "/x/\(version)/cli.js", bundle: downloaded ? "/dl/\(version)/Dashboard.bundle" : nil)
    }
    let downloads = ["0.3.0", "0.4.0", "0.5.0", "0.6.0"].map { copy($0) }
    equal(redundantDashboards(downloaded: downloads, running: [copy("0.5.0", downloaded: false)], refused: []), ["0.3.0", "0.4.0", "0.5.0"],
          "the copy inside the app makes older downloads redundant, and a newer one waits")
    equal(redundantDashboards(downloaded: downloads, running: [copy("0.5.0"), copy("0.4.0")], refused: ["0.6.0"]), ["0.3.0", "0.6.0"],
          "never a copy one of two dashboards still runs")
    equal(redundantDashboards(downloaded: downloads, running: [DashboardCopy(version: nil, entry: "/checkout/src/cli.ts", bundle: nil)], refused: []),
          [], "nothing beside a checkout")
    var agentAtWork = base
    agentAtWork.busy = true
    agentAtWork.busyWith = ["agent"]
    equal(busyAcross([("Work", base), ("Personal", agentAtWork)]), "the morning agent on Personal", "what an update would stop, by dashboard")
    equal(busyAcross([(nil, agentAtWork)]), "the morning agent", "unnamed with one")
    equal(busyAcross([("Work", base), ("Personal", nil)]), nil, "nothing busy")
    equal(noticeText(.briefReady(open: 2), dashboard: "Personal").title, "Your personal brief is ready", "a notice names its dashboard")
    equal(noticeText(.agentFailed(error: nil), dashboard: "Work").title, "The work morning agent failed", "a failure too")
    let logged = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("daily-focus-self-test-\(getpid()).log")
    let lines = LogLines(LogFile(url: logged), label: "Work")
    lines.add(Data("one\ntw".utf8))
    lines.add(Data("o\n".utf8))
    lines.label = nil
    lines.add(Data("three".utf8))
    lines.flush()
    equal((try? String(contentsOf: logged, encoding: .utf8)) ?? "", "[Work] one\n[Work] two\nthree\n", "whole lines, labelled while there are two")
    try? FileManager.default.removeItem(at: logged)

    // The build writes them; a built app without them would show an empty window.
    if Bundle.main.bundleURL.pathExtension == "app" {
        let acknowledged = acknowledgementsText() ?? ""
        check(acknowledged.contains("Node.js") && acknowledged.contains("GitHub CLI") && acknowledged.contains("third-party"),
              "the acknowledgements carry Node.js, the GitHub CLI and its dependencies")
    }

    print(failures == 0 ? "self-test passed: \(checks) checks" : "self-test failed: \(failures) of \(checks) checks")
    return failures == 0
}
