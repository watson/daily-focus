// The menu, the icon, the status polling and the notifications. The servers
// themselves are `Dashboard`'s business, one for each dashboard the app runs (see
// `Dashboards.swift`); this file only shows what they and the servers say.

import AppKit
import ServiceManagement
import UserNotifications

private let notifiedBriefKey = "notifiedBriefAt"
private let notifiedFailureKey = "notifiedFailedRunId"
private let notifiedUpdateKey = "notifiedUpdate"
/// Notifications about updates, which a click answers with the menu, where the update is.
private let updateNotices: Set<String> = ["update", "update-download", "dashboard-refused"]

/// Runs `body` from the main run loop rather than from a block on the main
/// dispatch queue, for anything that waits in a run loop of its own: an alert, or
/// a quit that waits for the server to stop. That queue runs one block at a time,
/// so from inside a block of its own, the wait would hold up every other one,
/// including the one that says the server has stopped, and the quit never finishes.
private func fromRunLoop(_ body: @escaping () -> Void) {
    RunLoop.main.perform(inModes: [.common], block: body)
}

/// When a downloaded update may go in.
private enum Consent {
    /// Once nothing in the dashboard is at work: an update the user asked for.
    case whenIdle
    /// Once nothing is at work and nobody has used the dashboard for a while: an
    /// update that started on its own.
    case whenQuiet
    /// Now, whatever it stops: the user said so.
    case now
}

private enum Reading {
    /// Nothing asked yet, since the dashboard last started.
    case nothing
    case status(DashboardStatus)
    /// A dashboard from before `/api/status`, which can only say that it is up.
    case healthOnly
    case unreachable
}

/// A dashboard the app runs or watches, what it last said, and its part of the menu.
@MainActor
private final class Watched {
    let dashboard: Dashboard
    var reading: Reading = .nothing
    var readingFrom: URL?
    var firstPoll = true
    var polling = false
    var pollAgain = false
    /// Opens it in the browser once it listens: a dashboard just added, whose setup
    /// screen is what the user wants next.
    var openWhenRunning = false
    let statusLineItem = NSMenuItem()
    let attachedItem = NSMenuItem()
    let openItem = NSMenuItem()
    let settingsItem = NSMenuItem(title: "Settings…", action: nil, keyEquivalent: "")
    let briefItem = NSMenuItem(title: "Write a Fresh Brief", action: nil, keyEquivalent: "")
    let restartItem = NSMenuItem()
    let removeItem = NSMenuItem()

    init(_ dashboard: Dashboard) {
        self.dashboard = dashboard
    }

    var slot: DashboardSlot { dashboard.slot }

    var status: DashboardStatus? {
        if case .status(let status) = reading { return status }
        return nil
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, UNUserNotificationCenterDelegate {
    private let environment = ProcessInfo.processInfo.environment
    /// The data folder every dashboard keeps its store in.
    private lazy var folder = dataFolder(environment)
    /// The dashboards, in the order the menu shows them: the first one the app ever
    /// ran, then the one added beside it.
    private var watched: [Watched] = []
    private lazy var updater = Updater(environment: environment, log: LogFile(url: logURL))
    private var statusItem: NSStatusItem?
    private let menu = NSMenu()
    private let nodeItem = NSMenuItem(title: "Download Node.js…", action: nil, keyEquivalent: "")
    private let addItem = NSMenuItem()
    private let loginItem = NSMenuItem(title: "Open at Login", action: nil, keyEquivalent: "")
    /// With two dashboards, restarting and removing each, kept out of the way.
    private let dashboardsItem = NSMenuItem(title: "Dashboards", action: nil, keyEquivalent: "")
    private let dashboardsMenu = NSMenu()
    private let logItem = NSMenuItem(title: "Show Log", action: nil, keyEquivalent: "")
    private let aboutItem = NSMenuItem(title: "About Daily Focus", action: nil, keyEquivalent: "")
    private let quitItem = NSMenuItem(title: "Quit Daily Focus", action: nil, keyEquivalent: "q")
    private let updateItem = NSMenuItem()
    private let downloadItem = NSMenuItem()
    private let updatesItem = NSMenuItem(title: "Updates", action: nil, keyEquivalent: "")
    private let checkItem = NSMenuItem(title: "Check for Updates", action: nil, keyEquivalent: "")
    private let stableItem = NSMenuItem(title: "Stable Releases", action: nil, keyEquivalent: "")
    private let developmentItem = NSMenuItem(title: "Development Builds", action: nil, keyEquivalent: "")
    private let automaticItem = NSMenuItem(title: "Update Automatically", action: nil, keyEquivalent: "")

    private var pollTimer: DispatchSourceTimer?
    private var updateTimer: DispatchSourceTimer?
    /// The downloaded dashboard the app restarted the dashboards to run, until they all run.
    private var restartingInto: String?
    /// When the update being installed may go in.
    private var consent: Consent = .whenIdle
    /// The version last tried on its own, which isn't tried on its own again: one
    /// that went in isn't offered any more, and one that failed is offered by hand.
    private var triedUnattended: String?
    private var signalSources: [DispatchSourceSignal] = []
    private var activity: NSObjectProtocol?

    func applicationWillFinishLaunching(_ notification: Notification) {
        // Before launch finishes, so a notification clicked while the app wasn't
        // running is delivered to it.
        UNUserNotificationCenter.current().delegate = self
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        quitOnSignals()
        // The dashboard keeps a clock, the morning agent's, and this app keeps the
        // dashboard; App Nap would stretch both while nobody looks at the menu.
        activity = ProcessInfo.processInfo.beginActivity(
            options: .userInitiatedAllowingIdleSystemSleep,
            reason: "Keeping the Daily Focus dashboard running"
        )
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }

        for slot in savedSlots(folder: folder, environment: environment) { watched.append(makeWatched(slot)) }
        labelDashboards()
        layOutMenu()
        updater.onChange = { [weak self] in self?.updaterChanged() }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 30, repeating: 30)
        timer.setEventHandler { [weak self] in self?.pollAll() }
        timer.resume()
        pollTimer = timer
        // A release a day at most, usually fewer: four looks a day find it the same day.
        let updates = DispatchSource.makeTimerSource(queue: .main)
        updates.schedule(deadline: .now() + 15, repeating: 6 * 60 * 60)
        updates.setEventHandler { [weak self] in self?.updater.check() }
        updates.resume()
        updateTimer = updates

        refreshMenu()
        for each in watched { each.dashboard.start() }
    }

    /// Quits once every server the app runs has stopped.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        pollTimer?.cancel()
        updateTimer?.cancel()
        updater.discardStagedApp()
        guard watched.contains(where: { $0.dashboard.hasChild }) else {
            for each in watched { each.dashboard.stop {} }
            return .terminateNow
        }
        // At least one stops later, so the last to stop is never one stopped at once.
        var waiting = watched.count
        for each in watched {
            each.dashboard.stop {
                waiting -= 1
                if waiting == 0 { NSApp.reply(toApplicationShouldTerminate: true) }
            }
        }
        refreshMenu()
        return .terminateLater
    }

    /// SIGTERM, SIGINT and SIGHUP quit the app the same way the menu does, so the
    /// server is stopped with it instead of being left running without a parent.
    private func quitOnSignals() {
        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { fromRunLoop { NSApp.terminate(nil) } }
            source.resume()
            signalSources.append(source)
        }
    }

    // MARK: The menu

    private func buildMenu() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.menu = menu
        statusItem = item

        menu.delegate = self
        menu.autoenablesItems = false
        dashboardsMenu.autoenablesItems = false
        dashboardsItem.submenu = dashboardsMenu

        buildUpdatesMenu()

        for (menuItem, action) in [
            (updateItem, #selector(installUpdate)),
            (nodeItem, #selector(downloadNode)),
            (addItem, #selector(addDashboard)),
            (loginItem, #selector(toggleOpenAtLogin)),
            (logItem, #selector(showLog)),
            (aboutItem, #selector(showAbout)),
            (quitItem, #selector(quit)),
        ] {
            menuItem.target = self
            menuItem.action = action
        }
        addItem.toolTip = "Runs a second dashboard beside this one, for the other half of your life, with its own store "
            + "in the same folder and its own port."
    }

    /// A dashboard, with its part of the menu, wired to the app.
    private func makeWatched(_ slot: DashboardSlot) -> Watched {
        let each = Watched(Dashboard(slot: slot, folder: folder, environment: environment))
        each.dashboard.onChange = { [weak self, weak each] in
            guard let self, let each else { return }
            self.dashboardChanged(each)
        }
        each.dashboard.onRefused = { [weak self] version in self?.dashboardRefused(version) }
        each.statusLineItem.isEnabled = false
        each.attachedItem.title = "Run by another process"
        each.attachedItem.isEnabled = false
        // The app never takes over a dashboard it didn't start: the other one may
        // be a LaunchAgent that would fight it for the port. Say how to hand it over.
        each.attachedItem.toolTip = "Something other than this app, such as daily-focus service or a terminal, runs the dashboard "
            + "on this port. To have the app run it, stop that one, then quit and reopen Daily Focus."
        for (menuItem, action) in [
            (each.openItem, #selector(openDashboard(_:))),
            (each.settingsItem, #selector(openSettings(_:))),
            (each.briefItem, #selector(writeBrief(_:))),
            (each.restartItem, #selector(restartDashboard(_:))),
            (each.removeItem, #selector(removeDashboard(_:))),
        ] {
            menuItem.target = self
            menuItem.action = action
            menuItem.representedObject = slot.id
        }
        return each
    }

    /// What the log and the menu call each dashboard: nothing with one, its profile with two.
    private func labelDashboards() {
        for each in watched { each.dashboard.label = watched.count > 1 ? profileLabel(each.slot.profile) : nil }
    }

    /// Puts the items in the menu for one dashboard or for two. Only ever from a
    /// click, which has closed the menu: rebuilt while open, it would lose its place.
    private func layOutMenu() {
        menu.removeAllItems()
        dashboardsMenu.removeAllItems()
        var items: [NSMenuItem] = []
        if watched.count == 1, let only = watched.first {
            only.openItem.title = "Open Daily Focus"
            only.openItem.keyEquivalent = "o"
            only.settingsItem.keyEquivalent = ","
            only.restartItem.title = "Restart Dashboard"
            items = [only.statusLineItem, only.attachedItem, updateItem, only.openItem, only.settingsItem, only.briefItem, nodeItem,
                     NSMenuItem.separator(), addItem, loginItem, updatesItem, only.restartItem, logItem]
        } else {
            items = [updateItem]
            for (index, each) in watched.enumerated() {
                let label = profileLabel(each.slot.profile)
                each.openItem.title = "Open \(label)"
                // The first dashboard keeps the shortcuts it had alone.
                each.openItem.keyEquivalent = index == 0 ? "o" : ""
                each.settingsItem.keyEquivalent = index == 0 ? "," : ""
                each.restartItem.title = "Restart \(label)"
                each.removeItem.title = "Remove \(label)…"
                items += [each.statusLineItem, each.attachedItem, each.openItem, each.settingsItem, each.briefItem, NSMenuItem.separator()]
                dashboardsMenu.addItem(each.restartItem)
            }
            dashboardsMenu.addItem(NSMenuItem.separator())
            for each in watched { dashboardsMenu.addItem(each.removeItem) }
            items += [nodeItem, loginItem, updatesItem, dashboardsItem, logItem]
        }
        for item in items + [NSMenuItem.separator(), aboutItem, quitItem] { menu.addItem(item) }
    }

    /// Which releases to offer, and whether they go in on their own. The versions are
    /// in About Daily Focus.
    private func buildUpdatesMenu() {
        let submenu = NSMenu()
        submenu.autoenablesItems = false
        for (menuItem, action) in [
            (checkItem, #selector(checkForUpdates)),
            (downloadItem, #selector(downloadApp)),
            (stableItem, #selector(chooseTrack(_:))),
            (developmentItem, #selector(chooseTrack(_:))),
            (automaticItem, #selector(toggleAutomatic)),
        ] {
            menuItem.target = self
            menuItem.action = action
        }
        stableItem.toolTip = "Releases cut by hand, every so often."
        developmentItem.toolTip = "A build of every change, as soon as it is merged. Newer, and less tried."
        automaticItem.toolTip = "Installs updates on its own once nobody has used the dashboard for half an hour, "
            + "and never while the morning agent, the assistant or the setup screen is at work."
        for item in [checkItem, downloadItem, NSMenuItem.separator(), automaticItem, NSMenuItem.separator(),
                     stableItem, developmentItem] {
            submenu.addItem(item)
        }
        updatesItem.submenu = submenu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        // "3 hours ago" was right when it was polled; work it out again for now.
        refreshMenu()
    }

    private func refreshMenu() {
        let several = watched.count > 1
        for each in watched {
            let line = currentStatusLine(each)
            each.statusLineItem.title = several ? "\(profileLabel(each.slot.profile)): \(line)" : line
            each.attachedItem.isHidden = !each.dashboard.isAttached
            each.openItem.isEnabled = each.dashboard.url != nil
            each.settingsItem.isEnabled = each.dashboard.url != nil
            each.briefItem.isEnabled = canWriteBrief(each)
            switch each.dashboard.state {
            case .attached, .preparing, .stopping, .stopped: each.restartItem.isEnabled = false
            default: each.restartItem.isEnabled = true
            }
            each.removeItem.isEnabled = several
        }
        nodeItem.isHidden = !watched.contains { $0.dashboard.state == .needsNode }
        let adding = profileToAdd(watched.map(\.slot))
        addItem.isHidden = adding == nil
        if let adding { addItem.title = "Add a \(profileLabel(adding)) Dashboard" }
        refreshUpdates()
        switch SMAppService.mainApp.status {
        case .enabled: loginItem.state = .on
        case .requiresApproval: loginItem.state = .mixed
        default: loginItem.state = .off
        }

        // Something to see to on either outranks the other's agent at work.
        let looks = watched.map(currentLook)
        let look: IconLook = looks.contains(.attention) ? .attention : looks.contains(.working) ? .working : .normal
        statusItem?.button?.image = menuBarIcon(look)
        let stores = watched.map { $0.status?.dataDir ?? $0.dashboard.expectedStore }
        statusItem?.button?.toolTip = (["Daily Focus"] + stores).joined(separator: "\n")
    }

    private func currentStatusLine(_ each: Watched) -> String {
        switch each.dashboard.state {
        case .preparing, .starting: return "Starting…"
        case .restarting: return "Restarting…"
        case .needsNode: return "Node.js 22.18 or newer is needed"
        case .blocked(let reason): return reason
        case .stopping, .stopped: return "Stopping…"
        case .running, .attached:
            switch each.reading {
            case .status(let status): return statusLine(status, now: Date())
            case .healthOnly: return "Running"
            case .unreachable: return "The dashboard isn't answering"
            case .nothing: return each.dashboard.isAttached ? "Checking the dashboard…" : "Starting…"
            }
        }
    }

    private func currentLook(_ each: Watched) -> IconLook {
        switch each.dashboard.state {
        case .needsNode, .blocked: return .attention
        case .running, .attached:
            guard let status = each.status else { return .normal }
            if status.agent?.running == true { return .working }
            return needsAttention(status) ? .attention : .normal
        default: return .normal
        }
    }

    private func canWriteBrief(_ each: Watched) -> Bool {
        guard each.dashboard.url != nil else { return false }
        switch each.reading {
        case .status(let status): return status.agent?.enabled != false && status.agent?.running != true
        // An older dashboard can't say whether its agent is on; it will say so if it isn't.
        case .healthOnly: return true
        case .nothing, .unreachable: return false
        }
    }

    /// The dashboard a menu item belongs to, by the slot it was made for.
    private func watched(for item: Any?) -> Watched? {
        let id = (item as? NSMenuItem)?.representedObject as? String
        return watched.first { $0.slot.id == id } ?? watched.first
    }

    // MARK: Actions

    @objc private func openDashboard(_ sender: Any?) {
        open(watched(for: sender))
    }

    private func open(_ each: Watched?) {
        guard let url = each?.dashboard.expectedURL else { return }
        NSWorkspace.shared.open(url)
    }

    /// The dashboard's own settings page: everything is set there, nothing here.
    @objc private func openSettings(_ sender: Any?) {
        guard let url = watched(for: sender)?.dashboard.expectedURL, let settings = URL(string: "#settings", relativeTo: url) else { return }
        NSWorkspace.shared.open(settings.absoluteURL)
    }

    @objc private func writeBrief(_ sender: Any?) {
        guard let each = watched(for: sender), let url = each.dashboard.url else { return }
        each.briefItem.isEnabled = false
        fetch(url.appendingPathComponent("api/agent/run"), method: "POST", timeout: 30) { [weak self] code, data in
            guard let self else { return }
            switch code {
            case nil:
                self.alert("Daily Focus didn't answer", "The dashboard at \(url.absoluteString) didn't answer the request.")
            case 409:
                self.alert("The morning agent can't start", errorMessage(data) ?? "It is off, or already running.")
            case let code? where code >= 400:
                self.alert("The morning agent didn't start", errorMessage(data) ?? "The dashboard answered HTTP \(code).")
            default:
                break
            }
            self.poll(each)
        }
    }

    /// A second dashboard, for the profile the first isn't, on the next port. Its
    /// store is a folder beside the first's, which its setup screen fills in, so it
    /// opens in the browser once it listens.
    @objc private func addDashboard() {
        guard let profile = profileToAdd(watched.map(\.slot)) else { return }
        let slot = DashboardSlot(id: profile, profile: profile, port: nextPort(watched.map(\.slot)))
        let each = makeWatched(slot)
        each.openWhenRunning = true
        watched.append(each)
        saveSlots(watched.map(\.slot), folder: folder)
        labelDashboards()
        layOutMenu()
        refreshMenu()
        each.dashboard.start()
    }

    /// Stops running a dashboard, leaving its store where it is.
    @objc private func removeDashboard(_ sender: Any?) {
        guard watched.count > 1, let each = watched(for: sender) else { return }
        let label = profileLabel(each.slot.profile)
        let store = (each.status?.dataDir ?? each.dashboard.expectedStore).replacingOccurrences(of: NSHomeDirectory(), with: "~")
        confirm("Remove the \(label.lowercased()) dashboard?",
                "Daily Focus stops running it. Its briefs, notes and settings stay in \(store), and adding it again picks them up.",
                button: "Remove") {
            guard let index = self.watched.firstIndex(where: { $0 === each }) else { return }
            self.watched.remove(at: index)
            saveSlots(self.watched.map(\.slot), folder: self.folder)
            self.labelDashboards()
            self.layOutMenu()
            self.refreshMenu()
            each.dashboard.stop { each.dashboard.forgetChild() }
        }
    }

    /// Whichever the newest release holds for this app: a new app, or a new dashboard.
    /// What updating would stop in the dashboard is the user's to stop or wait for.
    @objc private func installUpdate() {
        guard let update = currentOffer()?.update else { return }
        if let busy = wouldStop(update) {
            askToInterrupt(update, busy, title: "Stop \(busy) to update?")
        } else {
            install(update, consent: .whenIdle)
        }
    }

    private func install(_ update: Update, consent: Consent) {
        guard updater.phase == .idle else { return }
        self.consent = consent
        updater.install(update) { [weak self] problem in
            guard let self else { return }
            if let problem {
                self.updateFailed(update, problem)
                return
            }
            // A fresh look at whether anything is running before the update goes in.
            // With no dashboard to ask, nothing is.
            if !self.watched.contains(where: { $0.dashboard.url != nil }) {
                self.applyUpdate()
            } else {
                self.pollAll()
            }
        }
    }

    /// For a new app this copy can't put in its own place.
    @objc private func downloadApp() {
        guard let version = currentOffer()?.download else { return }
        openReleasePage(version)
    }

    /// The release page, which holds the disk image.
    private func openReleasePage(_ version: String) {
        NSWorkspace.shared.open(releasesURL.appendingPathComponent("tag").appendingPathComponent("v\(version)"))
    }

    /// Asks what to do about an update that would stop `busy`: wait for it, stop it,
    /// or neither.
    private func askToInterrupt(_ update: Update, _ busy: String, title: String) {
        fromRunLoop {
            self.comeForward()
            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = "Updating now stops \(busy) and restarts Daily Focus. Or Daily Focus can update as soon as \(busy) is done."
            alert.addButton(withTitle: "Update When Done")
            alert.addButton(withTitle: "Update Now")
            alert.addButton(withTitle: "Cancel")
            switch alert.runModal() {
            case .alertFirstButtonReturn: self.install(update, consent: .whenIdle)
            case .alertSecondButtonReturn: self.install(update, consent: .now)
            default: break
            }
        }
    }

    /// An update that didn't go in. A new app can still be had from its release page.
    /// One that started on its own says nothing here: it is offered by notification
    /// instead, as if it hadn't been tried.
    private func updateFailed(_ update: Update, _ problem: String) {
        if consent == .whenQuiet {
            announceOffer()
            return
        }
        guard case .app(let version) = update else {
            alert("Daily Focus couldn't install the update", problem)
            return
        }
        confirm("Daily Focus couldn't update itself", "\(problem) Its release page has the disk image.",
                button: "Open Release Page") { self.openReleasePage(version) }
    }

    /// Quits, leaving a shell to open the app now in this one's place once this one
    /// has gone: until then, its dashboard might still answer, and the new app would
    /// watch it instead of starting its own. The settings this app was started with,
    /// such as the data folder and the port, go with it.
    private func relaunch(_ version: String) {
        var open: [String] = []
        for (key, value) in environment.sorted(by: { $0.key < $1.key }) where key.hasPrefix("DAILY_FOCUS_") {
            open += ["--env", "\(key)=\(value)"]
        }
        open.append(Bundle.main.bundlePath)
        let waiter = Process()
        waiter.executableURL = URL(fileURLWithPath: "/bin/sh")
        waiter.arguments = ["-c", "pid=$1; shift; while kill -0 \"$pid\" 2>/dev/null; do /bin/sleep 0.2; done; exec /usr/bin/open \"$@\"",
                            "sh", String(getpid())] + open
        waiter.standardInput = FileHandle.nullDevice
        waiter.standardOutput = FileHandle.nullDevice
        waiter.standardError = FileHandle.nullDevice
        do {
            try waiter.run()
        } catch {
            LogFile(url: logURL).note("couldn't arrange to open Daily Focus \(version) again: \(error.localizedDescription)")
            alert("Daily Focus \(version) is installed", "Quit Daily Focus and open it again to start it.")
            return
        }
        fromRunLoop { NSApp.terminate(nil) }
    }

    @objc private func checkForUpdates() {
        updater.check { [weak self] problem in
            guard let self else { return }
            if let problem {
                self.alert("Daily Focus couldn't check for updates", problem)
                return
            }
            let offer = self.currentOffer()
            if let update = offer?.update {
                if let busy = self.wouldStop(update) {
                    self.askToInterrupt(update, busy, title: "Daily Focus \(update.version) is available")
                } else {
                    self.confirm("Daily Focus \(update.version) is available", "Updating restarts Daily Focus.",
                                 button: "Update") { self.install(update, consent: .whenIdle) }
                }
            } else if let version = offer?.download {
                self.confirm("Daily Focus \(version) is available", "\(cantReplace(self.ownReplacementProblem())) Its release page has the disk image.",
                             button: "Download") { self.downloadApp() }
            } else {
                let newest = self.updater.latest?.version ?? "the one running"
                self.alert("Daily Focus is up to date", "The newest on \(self.trackName(self.updater.track)) is \(newest).")
            }
        }
    }

    @objc private func chooseTrack(_ sender: NSMenuItem) {
        updater.track = sender === developmentItem ? .development : .stable
    }

    @objc private func toggleAutomatic() {
        updater.automatic.toggle()
    }

    @objc private func downloadNode() {
        NSWorkspace.shared.open(URL(string: "https://nodejs.org")!)
    }

    @objc private func toggleOpenAtLogin() {
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled || service.status == .requiresApproval {
                try service.unregister()
            } else {
                try service.register()
            }
        } catch {
            alert("Daily Focus couldn't change Open at Login", error.localizedDescription)
        }
        // macOS may want the user to allow it in System Settings before it counts.
        if service.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
        refreshMenu()
    }

    @objc private func restartDashboard(_ sender: Any?) {
        watched(for: sender)?.dashboard.restart()
    }

    @objc private func showLog() {
        NSWorkspace.shared.open(logURL)
    }

    /// The standard panel, with the app's version and Info.plist's copyright, and
    /// between them the dashboard's version, which updates without the app's, the
    /// newest release, and the repository.
    @objc private func showAbout() {
        comeForward()
        // CFBundleVersion is the version again, which the panel would add in brackets.
        NSApp.orderFrontStandardAboutPanel(options: [.version: "", .credits: aboutCredits()])
    }

    private func aboutCredits() -> NSAttributedString {
        var lines = [dashboardVersionLine()]
        if let error = updater.checkError {
            lines.append("Couldn't check for updates: \(error)")
        } else if let latest = updater.latest, let at = updater.checkedAt {
            lines.append("Newest is \(latest.version), checked \(ago(at, now: Date()))")
        }
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.paragraphSpacing = 4
        let style: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize),
            .foregroundColor: NSColor.labelColor,
            .paragraphStyle: paragraph,
        ]
        let credits = NSMutableAttributedString(string: lines.joined(separator: "\n") + "\n", attributes: style)
        var link = style
        link[.link] = repositoryURL
        credits.append(NSAttributedString(string: "github.com" + repositoryURL.path, attributes: link))
        return credits
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    /// An alert with a button that does something, and one that doesn't.
    private func confirm(_ title: String, _ text: String, button: String, then action: @escaping () -> Void) {
        fromRunLoop {
            self.comeForward()
            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = text
            alert.addButton(withTitle: button)
            alert.addButton(withTitle: "Not Now")
            if alert.runModal() == .alertFirstButtonReturn { action() }
        }
    }

    private func alert(_ title: String, _ text: String) {
        fromRunLoop {
            self.comeForward()
            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = text
            alert.runModal()
        }
    }

    /// A menu bar app is never the active one, and an alert behind other windows goes unseen.
    private func comeForward() {
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    // MARK: Status

    private func dashboardChanged(_ each: Watched) {
        if each.dashboard.url != each.readingFrom {
            each.reading = .nothing
            each.readingFrom = each.dashboard.url
        }
        if case .running(let url) = each.dashboard.state, let copy = each.dashboard.copy {
            updater.started(copy, running: watched.compactMap { $0.dashboard.copy })
            if each.openWhenRunning {
                each.openWhenRunning = false
                NSWorkspace.shared.open(url)
            }
            settleRestart()
        }
        refreshMenu()
        poll(each)
        announceOffer()
    }

    /// Once every dashboard the app restarted into an update runs again: whether all
    /// of them run it, and if not, which didn't.
    private func settleRestart() {
        guard let target = restartingInto else { return }
        let runners = watched.filter { !$0.dashboard.isAttached }
        guard runners.allSatisfy({ if case .running = $0.dashboard.state { return true } else { return false } }) else { return }
        restartingInto = nil
        guard let off = runners.first(where: { $0.dashboard.copy?.version != target }) else { return }
        updater.gaveUp(on: target)
        alert("Dashboard \(target) didn't start",
              "Daily Focus is running dashboard \(off.dashboard.copy?.version ?? "") instead. Show Log says why.")
    }

    private func pollAll() {
        for each in watched { poll(each) }
    }

    private func poll(_ each: Watched) {
        guard let url = each.dashboard.url else { return }
        if each.polling {
            each.pollAgain = true
            return
        }
        each.polling = true
        fetch(url.appendingPathComponent("api/status")) { [weak self] code, data in
            guard let self else { return }
            if code == 200, let data, let status = try? JSONDecoder().decode(DashboardStatus.self, from: data) {
                self.finishPoll(each, url, .status(status))
            } else if code == 404 {
                fetch(url.appendingPathComponent("api/health")) { code, _ in
                    self.finishPoll(each, url, code == 200 ? .healthOnly : .unreachable)
                }
            } else {
                self.finishPoll(each, url, .unreachable)
            }
        }
    }

    private func finishPoll(_ each: Watched, _ url: URL, _ result: Reading) {
        each.polling = false
        // An answer from a dashboard that has since stopped or moved says nothing about this one.
        if url == each.dashboard.url, watched.contains(where: { $0 === each }) {
            each.reading = result
            if case .status(let status) = result {
                learnProfile(each, status)
                tell(about: status, from: each)
                askAboutAutomaticUpdates(status)
            }
            refreshMenu()
            applyUpdate()
            updateUnattended()
        }
        if each.pollAgain {
            each.pollAgain = false
            poll(each)
        }
    }

    /// Keeps the profile a dashboard says it is, once its setup is finished, and
    /// gives it from the next start on. Until then its setup may still rename the
    /// store, and with no profile given, the dashboard follows.
    private func learnProfile(_ each: Watched, _ status: DashboardStatus) {
        guard each.slot.profile == nil, status.setupNeeded == false, let profile = status.profile, profiles.contains(profile) else { return }
        each.dashboard.slot.profile = profile
        saveSlots(watched.map(\.slot), folder: folder)
    }

    // MARK: Notifications

    /// What each dashboard has already been told about is kept apart, under its
    /// slot's key suffix, as are its notifications.
    private func tell(about status: DashboardStatus, from each: Watched) {
        let defaults = UserDefaults.standard
        let suffix = keySuffix(each.slot)
        let before = Notified(
            briefAt: defaults.object(forKey: notifiedBriefKey + suffix) as? Date,
            failedRunId: defaults.string(forKey: notifiedFailureKey + suffix)
        )
        let result = notices(for: status, after: before, firstPoll: each.firstPoll)
        each.firstPoll = false
        if let briefAt = result.notified.briefAt { defaults.set(briefAt, forKey: notifiedBriefKey + suffix) }
        if let failedRunId = result.notified.failedRunId { defaults.set(failedRunId, forKey: notifiedFailureKey + suffix) }
        for notice in result.notices { post(notice, from: each) }
    }

    /// `from` is the dashboard a notice is about, which a click opens; nil for the app's own.
    private func post(_ notice: Notice, from each: Watched? = nil) {
        let text = noticeText(notice, dashboard: each != nil && watched.count > 1 ? profileLabel(each?.slot.profile) : nil)
        let content = UNMutableNotificationContent()
        content.title = text.title
        content.body = text.body
        if let each { content.userInfo = ["dashboard": each.slot.id] }
        // One identifier per kind and dashboard, so today's notice replaces yesterday's
        // in Notification Centre, and one dashboard's never replaces the other's.
        let identifier: String
        switch notice {
        case .briefReady: identifier = "brief-ready"
        case .agentFailed: identifier = "agent-failed"
        case .updateAvailable: identifier = "update"
        case .downloadAvailable: identifier = "update-download"
        case .dashboardRefused: identifier = "dashboard-refused"
        }
        let suffix = each.map { keySuffix($0.slot) } ?? ""
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: identifier + suffix, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let identifier = response.notification.request.identifier
        let id = response.notification.request.content.userInfo["dashboard"] as? String
        DispatchQueue.main.async {
            if updateNotices.contains(identifier) {
                self.statusItem?.button?.performClick(nil)
            } else {
                self.open(self.watched.first { $0.slot.id == id } ?? self.watched.first)
            }
            completionHandler()
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    // MARK: Updates

    /// The dashboards the app runs itself. One run by another process is that
    /// process's to update, and carries on through the app's relaunch.
    private var runners: [Watched] { watched.filter { !$0.dashboard.isAttached } }

    /// What the newest release on the track holds for this app, once a check has found it.
    private func currentOffer() -> Offer? {
        guard let latest = updater.latest else { return nil }
        return offer(latest: latest, running: oldestRunning(), appVersion: updater.appVersion, appSource: updater.appSource,
                     nodeVersion: runners.lazy.compactMap(\.dashboard.nodeVersion).first ?? watched.first?.dashboard.nodeVersion,
                     canReplaceApp: ownReplacementProblem() == nil)
    }

    /// The oldest version the app's dashboards run, which an update is newer than or
    /// not. Nil while one hasn't started, or runs a checkout, which nothing updates.
    private func oldestRunning() -> String? {
        let versions = runners.map { $0.dashboard.copy?.version }
        guard !versions.isEmpty, !versions.contains(nil) else { return nil }
        return versions.compactMap { $0 }.min { (Version($0) ?? Version("0.0.0")!) < (Version($1) ?? Version("0.0.0")!) }
    }

    /// Why this copy can't put a newer app in its own place, or nil when it can.
    private func ownReplacementProblem() -> String? {
        guard updater.appSource != nil else { return "it was built from a checkout" }
        return replacementProblem(bundle: Bundle.main.bundleURL, team: ownTeam)
    }

    /// What installing an update now would stop in the dashboards the app runs, if
    /// anything: either kind restarts them.
    private func wouldStop(_ update: Update) -> String? {
        busyAcross(runners.map { (watched.count > 1 ? profileLabel($0.slot.profile) : nil, $0.status) })
    }

    /// What a downloaded update waits for before it goes in, to end "installs once …",
    /// or nil when it can go in now.
    private func holdUp(_ update: Update) -> String? {
        if consent == .now { return nil }
        if let busy = wouldStop(update) { return "\(busy) is done" }
        guard consent == .whenQuiet else { return nil }
        let used = runners.contains { each in each.status.map { !mayUpdateUnattended($0, now: Date()) } ?? false }
        guard used else { return nil }
        return watched.count > 1 ? "nobody has used either dashboard for half an hour" : "nobody has used the dashboard for half an hour"
    }

    private func trackName(_ track: Track) -> String {
        track == .stable ? "stable releases" : "development builds"
    }

    /// Sets each item once, to what it ends up as. Hiding or showing an item in the
    /// open menu, even for a moment, closes the Updates submenu under the pointer and
    /// leaves its title in the highlight's white with no highlight behind it.
    private func refreshUpdates() {
        let offer = currentOffer()
        // The update at the top of the menu, hidden without one.
        var title: String?
        var action = #selector(installUpdate)
        var tip: String?
        switch updater.phase {
        case .downloading(let update):
            title = "Downloading Daily Focus \(update.version)…"
        case .ready(let update):
            title = holdUp(update).map { "Daily Focus \(update.version) installs once \($0)" }
                ?? "Installing Daily Focus \(update.version)…"
        case .idle:
            if let update = offer?.update {
                title = "Update Daily Focus to \(update.version)"
            } else if let version = offer?.download {
                title = "Download Daily Focus \(version)…"
                action = #selector(downloadApp)
                tip = cantReplace(ownReplacementProblem())
            }
        }
        let enabled = updater.phase == .idle
        updateItem.isHidden = title == nil
        if let title { updateItem.title = title }
        updateItem.action = action
        updateItem.isEnabled = enabled
        updateItem.toolTip = tip
        // A new app this copy can't install, beside the dashboard update it can.
        downloadItem.isHidden = offer?.download == nil || action == #selector(downloadApp)
        if let version = offer?.download {
            downloadItem.title = "Download Daily Focus \(version)…"
            downloadItem.toolTip = cantReplace(ownReplacementProblem())
        }

        // The submenu offers what the top of the menu does, since a check would only
        // find the same update again. With nothing found, it checks.
        checkItem.title = title ?? "Check for Updates"
        checkItem.action = title == nil ? #selector(checkForUpdates) : action
        checkItem.isEnabled = title == nil || enabled
        checkItem.toolTip = tip
        stableItem.state = updater.track == .stable ? .on : .off
        developmentItem.state = updater.track == .development ? .on : .off
        automaticItem.state = updater.automatic ? .on : .off
        // A copy that can't check a download can't install one, on its own or not.
        automaticItem.isEnabled = ownTeam != nil
    }

    private func dashboardVersionLine() -> String {
        let lines = watched.map(dashboardVersionLine)
        guard watched.count > 1 else { return lines.first ?? "Dashboard starting…" }
        // Two running the same copy say it once.
        if Set(lines).count == 1, !watched.contains(where: \.dashboard.isAttached) { return lines[0] }
        return zip(watched, lines).map { "\(profileLabel($0.slot.profile)): \($1)" }.joined(separator: "\n")
    }

    private func dashboardVersionLine(_ each: Watched) -> String {
        if each.dashboard.isAttached {
            guard let version = each.status?.version else { return "Dashboard run by another process" }
            return "Dashboard \(version), run by another process"
        }
        guard let copy = each.dashboard.copy else { return "Dashboard starting…" }
        guard let version = copy.version else { return "Dashboard from a checkout" }
        return version.isEmpty ? "Dashboard of unknown version" : "Dashboard \(version)"
    }

    private func updaterChanged() {
        refreshMenu()
        announceOffer()
        updateUnattended()
    }

    /// Asks once, the first time the dashboard says setup is finished, whether updates
    /// should go in on their own. A copy that can't check a download can't install one.
    private func askAboutAutomaticUpdates(_ status: DashboardStatus) {
        guard !updater.askedAboutAutomatic, status.setupNeeded == false, ownTeam != nil else { return }
        updater.askedAboutAutomatic = true
        confirm("Keep Daily Focus up to date automatically?",
                "Daily Focus can install updates on its own once nobody has used the dashboard for half an hour, and never "
                    + "while the morning agent, the assistant or the setup screen is at work. You can change this under Updates in the menu.",
                button: "Turn On") { self.updater.automatic = true }
    }

    /// Starts an update on its own, when the user has turned that on, the newest
    /// release holds one this copy can install, and nobody has used any of the
    /// dashboards for a while.
    private func updateUnattended() {
        guard updater.automatic, updater.phase == .idle, restartingInto == nil,
              let update = currentOffer()?.update, update.version != triedUnattended, !watched.isEmpty,
              watched.allSatisfy({ each in each.status.map { mayUpdateUnattended($0, now: Date()) } ?? false })
        else { return }
        // Before it starts, since the updater is idle again before it says why it failed.
        triedUnattended = update.version
        install(update, consent: .whenQuiet)
    }

    /// A notification for each new version found, once. One that will go in on its
    /// own needs none, unless it failed to.
    private func announceOffer() {
        guard updater.phase == .idle, let offer = currentOffer(), let version = offer.update?.version ?? offer.download else { return }
        if updater.automatic, let update = offer.update, update.version != triedUnattended { return }
        let defaults = UserDefaults.standard
        guard defaults.string(forKey: notifiedUpdateKey) != version else { return }
        defaults.set(version, forKey: notifiedUpdateKey)
        post(offer.update != nil ? .updateAvailable(version: version) : .downloadAvailable(version: version, reason: ownReplacementProblem()))
    }

    /// Puts a downloaded update in, on a fresh answer that says it may go in: nothing
    /// in the dashboards is busy, and for one that started on its own, nobody has used
    /// them for a while; or the user said to go ahead anyway. Dashboards go in by
    /// restarting them into the update, all of them, which anything else that
    /// restarts one does too, and an app by swapping it in for this one and relaunching.
    private func applyUpdate() {
        guard case .ready(let update) = updater.phase, restartingInto == nil else { return }
        let isRunning = { (each: Watched) -> Bool in if case .running = each.dashboard.state { return true } else { return false } }
        if case .dashboard(let version) = update {
            let runners = self.runners
            guard !runners.isEmpty, runners.allSatisfy(isRunning) else { return }
            if runners.allSatisfy({ $0.dashboard.copy?.version == version }), let copy = runners[0].dashboard.copy {
                updater.started(copy, running: watched.compactMap { $0.dashboard.copy })
                return
            }
        }
        let running = watched.filter(isRunning)
        if !running.isEmpty {
            if holdUp(update) != nil { return }
            if running.contains(where: { if case .nothing = $0.reading { return true } else { return false } }) { return }
        }
        switch update {
        case .dashboard(let version):
            restartingInto = version
            for each in runners where each.dashboard.copy?.version != version { each.dashboard.restart() }
        case .app(let version):
            updater.replaceApp { [weak self] problem in
                guard let self else { return }
                if let problem {
                    self.updateFailed(update, problem)
                    return
                }
                self.relaunch(version)
            }
        }
    }

    private func dashboardRefused(_ version: String) {
        updater.gaveUp(on: version)
        if restartingInto == version { restartingInto = nil }
        post(.dashboardRefused(version: version))
    }
}
