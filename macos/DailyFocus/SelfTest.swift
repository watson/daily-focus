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

    let helper = "/Applications/Daily Focus.app/Contents/Helpers/Daily Focus Calendar.app"
    let child = childEnvironment(["PATH": "/usr/bin", "HOME": "/Users/x"], path: "/a:/b", calendarHelper: helper)
    equal(child["PATH"], "/a:/b", "child PATH")
    equal(child["HOME"], "/Users/x", "child keeps the rest")
    equal(child["DAILY_FOCUS_CALENDAR_APP"], helper, "child gets the bundled helper")
    equal(childEnvironment(["DAILY_FOCUS_CALENDAR_APP": "/mine.app"], path: "", calendarHelper: helper)["DAILY_FOCUS_CALENDAR_APP"],
          "/mine.app", "a named helper wins")
    equal(childEnvironment(["DAILY_FOCUS_CALENDAR_APP": " "], path: "", calendarHelper: helper)["DAILY_FOCUS_CALENDAR_APP"],
          helper, "an empty setting is no setting")
    equal(childEnvironment([:], path: "", calendarHelper: nil)["DAILY_FOCUS_CALENDAR_APP"], nil, "no helper, no setting")

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

    print(failures == 0 ? "self-test passed: \(checks) checks" : "self-test failed: \(failures) of \(checks) checks")
    return failures == 0
}
