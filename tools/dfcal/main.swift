// dfcal — dumps today's calendar facts as JSON, for the dashboard's agenda.
//
// Deliberately thin. Everything that can be decided without EventKit — which
// calendars count, which duplicates to fold, what a declined invitation means —
// is decided in src/calendar.ts, where it can be tested without a real calendar.
// What lives here is only what cannot: the framework call, and the reduction of
// attendees to a single self-status so that no colleague's address is ever
// written to disk.
//
// Usage: dfcal <output.json> [self@example.com,other@example.com]
//
// Always exits 0 after writing the output file, including on refusal. A caller
// reading "denied" from the file can say so; a caller seeing no file at all
// cannot tell refusal from a crash.

import EventKit
import Foundation

let args = CommandLine.arguments
guard args.count > 1 else {
    FileHandle.standardError.write("usage: dfcal <output.json> [self-addresses]\n".data(using: .utf8)!)
    exit(64)
}
let outPath = args[1]
let selfAddresses = Set(
    (args.count > 2 ? args[2] : "")
        .split(separator: ",")
        .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        .filter { !$0.isEmpty }
)

func isoString(_ date: Date?) -> Any {
    guard let date else { return NSNull() }
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    f.timeZone = TimeZone.current
    return f.string(from: date)
}

func write(_ payload: [String: Any]) -> Never {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
        exit(70)
    }
    // Sibling temp then rename, so a reader never sees half a file.
    let tmp = outPath + ".tmp"
    do {
        try data.write(to: URL(fileURLWithPath: tmp))
        _ = try FileManager.default.replaceItemAt(URL(fileURLWithPath: outPath), withItemAt: URL(fileURLWithPath: tmp))
    } catch {
        try? data.write(to: URL(fileURLWithPath: outPath))
    }
    exit(0)
}

let store = EKEventStore()
let gate = DispatchSemaphore(value: 0)
var granted = false
var failure: String?

store.requestFullAccessToEvents { ok, err in
    granted = ok
    if let err { failure = String(describing: err) }
    gate.signal()
}

// Long enough for a person to answer the TCC prompt the first time, bounded so a
// launcher that can never show one doesn't hang the poller forever.
if gate.wait(timeout: .now() + 120) == .timedOut {
    write(["error": "timeout", "detail": "no answer to the calendar access prompt"])
}
guard granted else {
    write([
        "error": "denied",
        "detail": failure ?? "macOS refused calendar access to this binary",
        "status": EKEventStore.authorizationStatus(for: .event).rawValue,
    ])
}

/// The user's own response to an invitation, or nil when it can't be established.
///
/// `isCurrentUser` is not usable here: on a Google account synced through
/// Calendar.app it is false for every attendee of every event, so the only
/// reliable route is matching the address the caller told us about.
func selfStatus(_ event: EKEvent) -> Int? {
    guard let attendees = event.attendees, !attendees.isEmpty else { return nil }
    for attendee in attendees {
        let mail = attendee.url.absoluteString
            .replacingOccurrences(of: "mailto:", with: "", options: .caseInsensitive)
            .lowercased()
        if selfAddresses.contains(mail) { return attendee.participantStatus.rawValue }
    }
    return nil
}

let calendars = store.calendars(for: .event).map { calendar -> [String: Any] in
    [
        "id": calendar.calendarIdentifier,
        "title": calendar.title,
        "source": calendar.source?.title ?? "",
    ]
}

let cal = Calendar.current
let dayStart = cal.startOfDay(for: Date())
let dayEnd = cal.date(byAdding: .day, value: 1, to: dayStart) ?? dayStart
let predicate = store.predicateForEvents(withStart: dayStart, end: dayEnd, calendars: nil)

let events = store.events(matching: predicate).map { event -> [String: Any] in
    var row: [String: Any] = [
        // Series-level for a recurring event, so it is never unique on its own —
        // src/calendar.ts pairs it with the start to identify one occurrence.
        "externalId": event.calendarItemExternalIdentifier ?? event.calendarItemIdentifier,
        "calendarId": event.calendar?.calendarIdentifier ?? "",
        "title": event.title ?? "",
        "start": isoString(event.startDate),
        "end": isoString(event.endDate),
        "allDay": event.isAllDay,
        // EKEventAvailability: notSupported -1, busy 0, free 1, tentative 2, unavailable 3.
        "availability": event.availability.rawValue,
    ]
    if let status = selfStatus(event) { row["selfStatus"] = status }
    if let url = event.url?.absoluteString, !url.isEmpty { row["url"] = url }
    return row
}

write(["generatedAt": isoString(Date()), "calendars": calendars, "events": events])
