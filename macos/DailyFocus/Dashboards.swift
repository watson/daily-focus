// Which dashboards the app runs: one per profile, each with its store in a folder
// of the same data folder (`~/.daily-focus/work`, `~/.daily-focus/personal`) and a
// port of its own. The dashboard decides where its store is from the data folder
// and the profile it is given (`src/stores.ts`); the app only says which.
//
// Everything here is a plain function of its arguments, apart from reading and
// writing the list, so `--self-test` can check it.

import Foundation

/// One dashboard the app runs.
struct DashboardSlot: Codable, Equatable {
    /// Stable across launches: what the leftover-process record and the
    /// notifications are kept under. The first dashboard's is `first`, which keeps
    /// the keys an app from before the list used.
    var id: String
    /// `work` or `personal`, or nil until the dashboard has said, once its setup
    /// is finished. A dashboard told none opens whichever store is there, so the
    /// app gives it one as soon as it knows, and a second can never open the same.
    var profile: String?
    /// 0 is any free port, for a development run.
    var port: Int
}

let profiles = ["work", "personal"]

/// "Work" or "Personal", for the menu and the notifications.
func profileLabel(_ profile: String?) -> String {
    profile == "personal" ? "Personal" : profile == "work" ? "Work" : "Daily Focus"
}

/// The data folder the dashboards keep their stores in, as the dashboard reads
/// `DAILY_FOCUS_DATA`: `~` expanded, and a relative path from home, where the app
/// starts them.
func dataFolder(_ environment: [String: String], home: String = NSHomeDirectory()) -> String {
    var path = (environment["DAILY_FOCUS_DATA"] ?? "").trimmingCharacters(in: .whitespaces)
    if path.isEmpty { path = "~/.daily-focus" }
    if path == "~" {
        path = home
    } else if path.hasPrefix("~/") {
        path = (home as NSString).appendingPathComponent(String(path.dropFirst(2)))
    } else if !path.hasPrefix("/") {
        path = (home as NSString).appendingPathComponent(path)
    }
    return (path as NSString).standardizingPath
}

/// The one dashboard the app runs when it has no list yet: on the port and for
/// the profile it was started with, if any, as before the list.
func firstSlot(_ environment: [String: String]) -> DashboardSlot {
    let profile = environment["DAILY_FOCUS_PROFILE"]?.trimmingCharacters(in: .whitespaces).lowercased()
    return DashboardSlot(id: "first", profile: profiles.contains(profile ?? "") ? profile : nil, port: probePort(environment) ?? 0)
}

/// The profile "Add a … Dashboard" offers: the other one, once the only dashboard
/// has said which it is. Nil with two, or with one that hasn't said yet.
func profileToAdd(_ slots: [DashboardSlot]) -> String? {
    guard slots.count == 1, let profile = slots[0].profile else { return nil }
    return profiles.first { $0 != profile }
}

/// The port for a dashboard added beside `slots`: the next after theirs, so the
/// first keeps 4321 and a second gets 4322. Any free one when they use any.
func nextPort(_ slots: [DashboardSlot]) -> Int {
    if slots.contains(where: { $0.port == 0 }) { return 0 }
    return (slots.map(\.port).max() ?? 4320) + 1
}

/// The environment a dashboard is started with: the app's, with its port and its
/// profile, and no profile when it hasn't said yet.
func slotEnvironment(_ base: [String: String], _ slot: DashboardSlot) -> [String: String] {
    var environment = base
    environment["DAILY_FOCUS_PORT"] = String(slot.port)
    if let profile = slot.profile {
        environment["DAILY_FOCUS_PROFILE"] = profile
    } else {
        environment.removeValue(forKey: "DAILY_FOCUS_PROFILE")
    }
    return environment
}

/// Whether a dashboard that says it serves `dataDir` is the one for this slot: its
/// profile's store in the data folder, or, before the slot knows its profile, any
/// store there, the data folder itself included, as before the profile folders.
func servesStore(_ dataDir: String?, folder: String, profile: String?) -> Bool {
    guard let dataDir, !dataDir.isEmpty else { return false }
    let resolve = { (path: String) in URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path }
    let store = resolve(dataDir)
    let root = resolve(folder)
    if let profile { return store == resolve((folder as NSString).appendingPathComponent(profile)) }
    return store == root || (store as NSString).deletingLastPathComponent == root
}

/// The suffix the slot's own UserDefaults keys carry. None for the first, whose
/// keys are the ones an app from before the list used.
func keySuffix(_ slot: DashboardSlot) -> String {
    slot.id == "first" ? "" : ".\(slot.id)"
}

private let slotsKey = "dashboards"

/// The dashboards for `folder`, as last saved, or the one to start with. Kept per
/// data folder, so a run on a throwaway one never sees the real list.
func savedSlots(folder: String, environment: [String: String], defaults: UserDefaults = .standard) -> [DashboardSlot] {
    guard let all = defaults.dictionary(forKey: slotsKey), let data = all[folder] as? Data,
          let slots = try? JSONDecoder().decode([DashboardSlot].self, from: data), !slots.isEmpty
    else { return [firstSlot(environment)] }
    return slots
}

func saveSlots(_ slots: [DashboardSlot], folder: String, defaults: UserDefaults = .standard) {
    var all = defaults.dictionary(forKey: slotsKey) ?? [:]
    all[folder] = try? JSONEncoder().encode(slots)
    defaults.set(all, forKey: slotsKey)
}
