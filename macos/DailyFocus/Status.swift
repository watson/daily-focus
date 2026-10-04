// What the dashboard says about itself, and what the menu and notifications make
// of it. Everything here is a plain function of its arguments, so `--self-test` can
// check it without a dashboard, a menu or a notification centre.

import Foundation

/// The answer to `GET /api/status`. Every field is optional, so that a dashboard a
/// version ahead of or behind this app is read as far as it goes rather than not
/// at all.
struct DashboardStatus: Decodable, Equatable {
    struct Brief: Decodable, Equatable {
        var generatedAt: String?
        var ageHours: Double?
        var stale: Bool?
        var open: Int?
    }

    struct Run: Decodable, Equatable {
        var id: String?
        var status: String?
        var startedAt: String?
        var endedAt: String?
        var error: String?
    }

    struct Agent: Decodable, Equatable {
        var enabled: Bool?
        var running: Bool?
        var nextRunAt: String?
        var last: Run?
    }

    var dataDir: String?
    var profile: String?
    var setupNeeded: Bool?
    var restartPending: Bool?
    var brief: Brief?
    var agent: Agent?
    var waitingOnYou: Int?
}

/// An ISO 8601 time as the server writes it, with or without milliseconds.
func parseDate(_ text: String?) -> Date? {
    guard let text, !text.isEmpty else { return nil }
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = withFraction.date(from: text) { return date }
    return ISO8601DateFormatter().date(from: text)
}

/// The last run, when it failed and nothing has been written since. A brief newer
/// than the failure means the failure is no longer what the user needs to hear.
func failedRun(_ status: DashboardStatus) -> DashboardStatus.Run? {
    guard let run = status.agent?.last, run.status == "failed" else { return nil }
    if let written = parseDate(status.brief?.generatedAt),
       let failed = parseDate(run.endedAt ?? run.startedAt),
       written > failed {
        return nil
    }
    return run
}

/// Whether the menu bar icon should ask for a look.
func needsAttention(_ status: DashboardStatus) -> Bool {
    status.setupNeeded == true || status.brief?.stale == true || failedRun(status) != nil
}

/// How long ago `date` was, in the words the status line uses.
func ago(_ date: Date, now: Date) -> String {
    let minutes = Int(max(0, now.timeIntervalSince(date)) / 60)
    if minutes < 1 { return "just now" }
    if minutes < 60 { return minutes == 1 ? "a minute ago" : "\(minutes) minutes ago" }
    let hours = minutes / 60
    if hours < 48 { return hours == 1 ? "an hour ago" : "\(hours) hours ago" }
    return "\(hours / 24) days ago"
}

/// "at 07:12", "yesterday at 07:12" or "on Oct 2 at 07:12", in the user's own clock format.
func whenText(_ date: Date, now: Date, calendar: Calendar, locale: Locale) -> String {
    let time = DateFormatter()
    time.locale = locale
    time.timeZone = calendar.timeZone
    time.dateStyle = .none
    time.timeStyle = .short
    let clock = time.string(from: date)
    if calendar.isDate(date, inSameDayAs: now) { return "at \(clock)" }
    if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
        return "yesterday at \(clock)"
    }
    let day = DateFormatter()
    day.locale = locale
    day.timeZone = calendar.timeZone
    day.setLocalizedDateFormatFromTemplate("MMMd")
    return "on \(day.string(from: date)) at \(clock)"
}

/// The line at the top of the menu, for a dashboard that answered `/api/status`.
func statusLine(_ status: DashboardStatus, now: Date, calendar: Calendar = .current, locale: Locale = .current) -> String {
    if status.agent?.running == true { return "The morning agent is writing a brief…" }
    if status.restartPending == true { return "Restarting to apply new settings…" }
    if let run = failedRun(status) {
        guard let when = parseDate(run.endedAt ?? run.startedAt) else { return "The morning agent failed" }
        return "The morning agent failed \(whenText(when, now: now, calendar: calendar, locale: locale))"
    }
    let written = parseDate(status.brief?.generatedAt)
        ?? status.brief?.ageHours.map { now.addingTimeInterval(-$0 * 3600) }
    guard let written else {
        return status.setupNeeded == true ? "No brief yet — finish setup in the dashboard" : "No brief yet"
    }
    if status.setupNeeded == true { return "Finish setup in the dashboard" }
    let age = ago(written, now: now)
    var parts = [status.brief?.stale == true ? "Brief out of date, updated \(age)" : "Brief updated \(age)"]
    if let open = status.brief?.open { parts.append("\(open) open") }
    if let waiting = status.waitingOnYou, waiting > 0 { parts.append("\(waiting) waiting on you") }
    return parts.joined(separator: " · ")
}

/// Something worth a notification.
enum Notice: Equatable {
    case briefReady(open: Int?)
    case agentFailed(error: String?)
}

/// What the app has already told the user about, kept across launches.
struct Notified: Equatable {
    var briefAt: Date?
    var failedRunId: String?
}

/// What to tell the user about `status`, and what will have been told once it has.
///
/// A brief that is already there when the app starts is not news, so the first
/// poll after launch only takes note of it. A failure is different: with a record
/// of an earlier one, this app has been watching before, and a failure it hasn't
/// told about happened while it wasn't looking. Without any record this is the
/// first launch, and a failure from before it is history.
func notices(for status: DashboardStatus, after notified: Notified, firstPoll: Bool) -> (notices: [Notice], notified: Notified) {
    var notices: [Notice] = []
    var updated = notified
    if let written = parseDate(status.brief?.generatedAt), written > (notified.briefAt ?? .distantPast) {
        if !firstPoll { notices.append(.briefReady(open: status.brief?.open)) }
        updated.briefAt = written
    }
    if let run = status.agent?.last, run.status == "failed", let id = run.id, id != notified.failedRunId {
        if !firstPoll || notified.failedRunId != nil { notices.append(.agentFailed(error: run.error)) }
        updated.failedRunId = id
    }
    return (notices, updated)
}

/// The title and body of a notification.
func noticeText(_ notice: Notice) -> (title: String, body: String) {
    switch notice {
    case .briefReady(let open):
        guard let open else { return ("Your brief is ready", "") }
        return ("Your brief is ready", open == 1 ? "1 open item" : "\(open) open items")
    case .agentFailed(let error):
        let reason = error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return ("The morning agent failed", reason.isEmpty ? "Open Daily Focus to see what it said." : reason)
    }
}

/// The `error` a dashboard put in a refusal, if it put one there.
func errorMessage(_ data: Data?) -> String? {
    guard let data,
          let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let error = body["error"] as? String,
          !error.isEmpty
    else { return nil }
    return error
}

/// Whether a `/api/health` answer came from a Daily Focus dashboard.
func isDashboardHealth(_ data: Data?) -> Bool {
    guard let data, let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
    // A dashboard says which store it serves; plenty of other things say ok.
    return body["ok"] as? Bool == true && (body["dataDir"] as? String).map { !$0.isEmpty } == true
}
