// The menu, the icon, the status polling and the notifications. The server itself
// is `Dashboard`'s business; this file only shows what it and the server say.

import AppKit
import ServiceManagement
import UserNotifications

private let notifiedBriefKey = "notifiedBriefAt"
private let notifiedFailureKey = "notifiedFailedRunId"
private let notifiedDashboardKey = "notifiedDashboardUpdate"
private let notifiedAppKey = "notifiedAppUpdate"
/// Notifications about updates, which a click answers with the menu, where the update is.
private let updateNotices: Set<String> = ["dashboard-update", "app-update", "dashboard-refused"]

/// Runs `body` from the main run loop rather than from a block on the main
/// dispatch queue, for anything that waits in a run loop of its own: an alert, or
/// a quit that waits for the server to stop. That queue runs one block at a time,
/// so from inside a block of its own, the wait would hold up every other one,
/// including the one that says the server has stopped, and the quit never finishes.
private func fromRunLoop(_ body: @escaping () -> Void) {
    RunLoop.main.perform(inModes: [.common], block: body)
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, UNUserNotificationCenterDelegate {
    private enum Reading {
        /// Nothing asked yet, since the dashboard last started.
        case nothing
        case status(DashboardStatus)
        /// A dashboard from before `/api/status`, which can only say that it is up.
        case healthOnly
        case unreachable
    }

    private let dashboard = Dashboard()
    private lazy var updater = Updater(environment: dashboard.environment, log: LogFile(url: logURL))
    private var statusItem: NSStatusItem?
    private let menu = NSMenu()
    private let statusLineItem = NSMenuItem()
    private let attachedItem = NSMenuItem()
    private let openItem = NSMenuItem(title: "Open Daily Focus", action: nil, keyEquivalent: "o")
    private let settingsItem = NSMenuItem(title: "Settings…", action: nil, keyEquivalent: ",")
    private let briefItem = NSMenuItem(title: "Write a Fresh Brief", action: nil, keyEquivalent: "")
    private let nodeItem = NSMenuItem(title: "Download Node.js…", action: nil, keyEquivalent: "")
    private let loginItem = NSMenuItem(title: "Open at Login", action: nil, keyEquivalent: "")
    private let restartItem = NSMenuItem(title: "Restart Dashboard", action: nil, keyEquivalent: "")
    private let logItem = NSMenuItem(title: "Show Log", action: nil, keyEquivalent: "")
    private let quitItem = NSMenuItem(title: "Quit Daily Focus", action: nil, keyEquivalent: "q")
    private let updateItem = NSMenuItem()
    private let appUpdateItem = NSMenuItem()
    private let updatesItem = NSMenuItem(title: "Updates", action: nil, keyEquivalent: "")
    private let appVersionItem = NSMenuItem()
    private let dashboardVersionItem = NSMenuItem()
    private let checkedItem = NSMenuItem()
    private let checkItem = NSMenuItem(title: "Check for Updates", action: nil, keyEquivalent: "")
    private let stableItem = NSMenuItem(title: "Stable Releases", action: nil, keyEquivalent: "")
    private let developmentItem = NSMenuItem(title: "Development Builds", action: nil, keyEquivalent: "")

    private var reading: Reading = .nothing
    private var readingFrom: URL?
    private var firstPoll = true
    private var polling = false
    private var pollAgain = false
    private var pollTimer: DispatchSourceTimer?
    private var updateTimer: DispatchSourceTimer?
    /// The downloaded dashboard the app restarted the dashboard to run, until it runs.
    private var restartingInto: String?
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

        dashboard.onChange = { [weak self] in self?.dashboardChanged() }
        dashboard.onRefused = { [weak self] version in self?.dashboardRefused(version) }
        updater.onChange = { [weak self] in self?.updaterChanged() }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 30, repeating: 30)
        timer.setEventHandler { [weak self] in self?.poll() }
        timer.resume()
        pollTimer = timer
        // A release a day at most, usually fewer: four looks a day find it the same day.
        let updates = DispatchSource.makeTimerSource(queue: .main)
        updates.schedule(deadline: .now() + 15, repeating: 6 * 60 * 60)
        updates.setEventHandler { [weak self] in self?.updater.check() }
        updates.resume()
        updateTimer = updates

        refreshMenu()
        dashboard.start()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        pollTimer?.cancel()
        updateTimer?.cancel()
        guard dashboard.hasChild else {
            dashboard.stop {}
            return .terminateNow
        }
        dashboard.stop { NSApp.reply(toApplicationShouldTerminate: true) }
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
        statusLineItem.isEnabled = false
        attachedItem.title = "Run by another process"
        attachedItem.isEnabled = false
        // The app never takes over a dashboard it didn't start: the other one may
        // be a LaunchAgent that would fight it for the port. Say how to hand it over.
        attachedItem.toolTip = "Something other than this app, such as daily-focus service or a terminal, runs the dashboard "
            + "on this port. To have the app run it, stop that one, then quit and reopen Daily Focus."

        buildUpdatesMenu()

        for (menuItem, action) in [
            (updateItem, #selector(installDashboard)),
            (appUpdateItem, #selector(downloadApp)),
            (openItem, #selector(openDashboard)),
            (settingsItem, #selector(openSettings)),
            (briefItem, #selector(writeBrief)),
            (nodeItem, #selector(downloadNode)),
            (loginItem, #selector(toggleOpenAtLogin)),
            (restartItem, #selector(restartDashboard)),
            (logItem, #selector(showLog)),
            (quitItem, #selector(quit)),
        ] {
            menuItem.target = self
            menuItem.action = action
        }

        for menuItem in [statusLineItem, attachedItem, updateItem, appUpdateItem, openItem, settingsItem, briefItem, nodeItem,
                         NSMenuItem.separator(), loginItem, updatesItem, restartItem, logItem, NSMenuItem.separator(), quitItem] {
            menu.addItem(menuItem)
        }
    }

    /// Both versions, since the dashboard updates without the app, and which releases to offer.
    private func buildUpdatesMenu() {
        let submenu = NSMenu()
        submenu.autoenablesItems = false
        for item in [appVersionItem, dashboardVersionItem, checkedItem] { item.isEnabled = false }
        for (menuItem, action) in [
            (checkItem, #selector(checkForUpdates)),
            (stableItem, #selector(chooseTrack(_:))),
            (developmentItem, #selector(chooseTrack(_:))),
        ] {
            menuItem.target = self
            menuItem.action = action
        }
        stableItem.toolTip = "Releases cut by hand, every so often."
        developmentItem.toolTip = "A build of every change, as soon as it is merged. Newer, and less tried."
        for item in [appVersionItem, dashboardVersionItem, checkedItem, checkItem, NSMenuItem.separator(), stableItem, developmentItem] {
            submenu.addItem(item)
        }
        updatesItem.submenu = submenu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        // "3 hours ago" was right when it was polled; work it out again for now.
        refreshMenu()
    }

    private func refreshMenu() {
        let state = dashboard.state
        statusLineItem.title = currentStatusLine()
        attachedItem.isHidden = !dashboard.isAttached
        nodeItem.isHidden = state != .needsNode
        openItem.isEnabled = dashboard.url != nil
        settingsItem.isEnabled = dashboard.url != nil
        briefItem.isEnabled = canWriteBrief
        switch state {
        case .attached, .preparing, .stopping, .stopped: restartItem.isEnabled = false
        default: restartItem.isEnabled = true
        }
        refreshUpdates()
        switch SMAppService.mainApp.status {
        case .enabled: loginItem.state = .on
        case .requiresApproval: loginItem.state = .mixed
        default: loginItem.state = .off
        }

        let look = currentLook()
        statusItem?.button?.image = menuBarIcon(look)
        var tip = "Daily Focus"
        if case .status(let status) = reading, let store = status.dataDir { tip += "\n\(store)" }
        statusItem?.button?.toolTip = tip
    }

    private func currentStatusLine() -> String {
        switch dashboard.state {
        case .preparing, .starting: return "Starting…"
        case .restarting: return "Restarting…"
        case .needsNode: return "Node.js 22.18 or newer is needed"
        case .blocked(let reason): return reason
        case .stopping, .stopped: return "Stopping…"
        case .running, .attached:
            switch reading {
            case .status(let status): return statusLine(status, now: Date())
            case .healthOnly: return "Running"
            case .unreachable: return "The dashboard isn't answering"
            case .nothing: return dashboard.isAttached ? "Checking the dashboard…" : "Starting…"
            }
        }
    }

    private func currentLook() -> IconLook {
        switch dashboard.state {
        case .needsNode, .blocked: return .attention
        case .running, .attached:
            guard case .status(let status) = reading else { return .normal }
            if status.agent?.running == true { return .working }
            return needsAttention(status) ? .attention : .normal
        default: return .normal
        }
    }

    private var canWriteBrief: Bool {
        guard dashboard.url != nil else { return false }
        switch reading {
        case .status(let status): return status.agent?.enabled != false && status.agent?.running != true
        // An older dashboard can't say whether its agent is on; it will say so if it isn't.
        case .healthOnly: return true
        case .nothing, .unreachable: return false
        }
    }

    // MARK: Actions

    @objc private func openDashboard() {
        guard let url = dashboard.expectedURL else { return }
        NSWorkspace.shared.open(url)
    }

    /// The dashboard's own settings page: everything is set there, nothing here.
    @objc private func openSettings() {
        guard let url = dashboard.expectedURL, let settings = URL(string: "#settings", relativeTo: url) else { return }
        NSWorkspace.shared.open(settings.absoluteURL)
    }

    @objc private func writeBrief() {
        guard let url = dashboard.url else { return }
        briefItem.isEnabled = false
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
            self.poll()
        }
    }

    @objc private func installDashboard() {
        guard let version = currentOffer()?.dashboard else { return }
        updater.install(version) { [weak self] problem in
            guard let self else { return }
            if let problem {
                self.alert("Daily Focus couldn't install the update", problem)
                return
            }
            // A fresh look at whether anything is running before the restart.
            self.poll()
        }
    }

    /// The release page, which holds the disk image: the app doesn't replace itself.
    @objc private func downloadApp() {
        guard let version = currentOffer()?.app else { return }
        NSWorkspace.shared.open(releasesURL.appendingPathComponent("tag").appendingPathComponent("v\(version)"))
    }

    @objc private func checkForUpdates() {
        updater.check { [weak self] problem in
            guard let self else { return }
            if let problem {
                self.alert("Daily Focus couldn't check for updates", problem)
                return
            }
            let offer = self.currentOffer()
            if let version = offer?.dashboard {
                self.confirm("Dashboard \(version) is available",
                             "Installing it restarts the dashboard, once the morning agent and the assistant aren't busy.",
                             button: "Install") { self.installDashboard() }
            } else if let version = offer?.app {
                self.confirm("Daily Focus \(version) is available", noticeText(.appAvailable(version: version, needed: offer?.appNeeded ?? false)).body,
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

    @objc private func restartDashboard() {
        dashboard.restart()
    }

    @objc private func showLog() {
        NSWorkspace.shared.open(logURL)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    /// An alert with a button that does something, and one that doesn't.
    private func confirm(_ title: String, _ text: String, button: String, then action: @escaping () -> Void) {
        fromRunLoop {
            if #available(macOS 14.0, *) {
                NSApp.activate()
            } else {
                NSApp.activate(ignoringOtherApps: true)
            }
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
            // A menu bar app is never the active one, and an alert behind other windows goes unseen.
            if #available(macOS 14.0, *) {
                NSApp.activate()
            } else {
                NSApp.activate(ignoringOtherApps: true)
            }
            let alert = NSAlert()
            alert.messageText = title
            alert.informativeText = text
            alert.runModal()
        }
    }

    // MARK: Status

    private func dashboardChanged() {
        if dashboard.url != readingFrom {
            reading = .nothing
            readingFrom = dashboard.url
        }
        if case .running = dashboard.state, let copy = dashboard.copy {
            updater.started(copy)
            if let target = restartingInto {
                restartingInto = nil
                if copy.version != target {
                    updater.gaveUp(on: target)
                    alert("Dashboard \(target) didn't start",
                          "Daily Focus is running dashboard \(copy.version ?? "") instead. Show Log says why.")
                }
            }
        }
        refreshMenu()
        poll()
        announceOffer()
    }

    private func poll() {
        guard let url = dashboard.url else { return }
        if polling {
            pollAgain = true
            return
        }
        polling = true
        fetch(url.appendingPathComponent("api/status")) { [weak self] code, data in
            guard let self else { return }
            if code == 200, let data, let status = try? JSONDecoder().decode(DashboardStatus.self, from: data) {
                self.finishPoll(url, .status(status))
            } else if code == 404 {
                fetch(url.appendingPathComponent("api/health")) { code, _ in
                    self.finishPoll(url, code == 200 ? .healthOnly : .unreachable)
                }
            } else {
                self.finishPoll(url, .unreachable)
            }
        }
    }

    private func finishPoll(_ url: URL, _ result: Reading) {
        polling = false
        // An answer from a dashboard that has since stopped or moved says nothing about this one.
        if url == dashboard.url {
            reading = result
            if case .status(let status) = result { tell(about: status) }
            refreshMenu()
            applyUpdate()
        }
        if pollAgain {
            pollAgain = false
            poll()
        }
    }

    // MARK: Notifications

    private func tell(about status: DashboardStatus) {
        let defaults = UserDefaults.standard
        let before = Notified(
            briefAt: defaults.object(forKey: notifiedBriefKey) as? Date,
            failedRunId: defaults.string(forKey: notifiedFailureKey)
        )
        let result = notices(for: status, after: before, firstPoll: firstPoll)
        firstPoll = false
        if let briefAt = result.notified.briefAt { defaults.set(briefAt, forKey: notifiedBriefKey) }
        if let failedRunId = result.notified.failedRunId { defaults.set(failedRunId, forKey: notifiedFailureKey) }
        for notice in result.notices { post(notice) }
    }

    private func post(_ notice: Notice) {
        let text = noticeText(notice)
        let content = UNMutableNotificationContent()
        content.title = text.title
        content.body = text.body
        // One identifier per kind, so today's notice replaces yesterday's in Notification Centre.
        let identifier: String
        switch notice {
        case .briefReady: identifier = "brief-ready"
        case .agentFailed: identifier = "agent-failed"
        case .dashboardAvailable: identifier = "dashboard-update"
        case .appAvailable: identifier = "app-update"
        case .dashboardRefused: identifier = "dashboard-refused"
        }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let identifier = response.notification.request.identifier
        DispatchQueue.main.async {
            if updateNotices.contains(identifier) {
                self.statusItem?.button?.performClick(nil)
            } else {
                self.openDashboard()
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

    /// What the newest release on the track holds for this app, once a check has found it.
    private func currentOffer() -> Offer? {
        guard let latest = updater.latest else { return nil }
        // A dashboard run by another process is that process's to update.
        let running = dashboard.isAttached ? nil : dashboard.copy?.version
        return offer(latest: latest, running: running, appVersion: updater.appVersion,
                     appSource: updater.appSource, nodeVersion: dashboard.nodeVersion)
    }

    private func trackName(_ track: Track) -> String {
        track == .stable ? "stable releases" : "development builds"
    }

    private func refreshUpdates() {
        let offer = currentOffer()
        updateItem.isHidden = false
        updateItem.isEnabled = false
        switch updater.phase {
        case .downloading(let version):
            updateItem.title = "Downloading Dashboard \(version)…"
        case .ready(let version):
            var busyWith: String?
            if case .status(let status) = reading, isBusy(status) {
                busyWith = status.agent?.running == true ? "the morning agent" : "the assistant"
            }
            updateItem.title = busyWith.map { "Dashboard \(version) installs once \($0) is done" } ?? "Installing Dashboard \(version)…"
        case .idle:
            if let version = offer?.dashboard {
                updateItem.title = "Install Dashboard \(version)"
                updateItem.isEnabled = true
            } else {
                updateItem.isHidden = true
            }
        }
        appUpdateItem.isHidden = offer?.app == nil
        if let version = offer?.app {
            appUpdateItem.title = "Download Daily Focus \(version)…"
            appUpdateItem.toolTip = noticeText(.appAvailable(version: version, needed: offer?.appNeeded ?? false)).body
        }

        appVersionItem.title = "App \(updater.appVersion)"
        dashboardVersionItem.title = dashboardVersionLine()
        checkedItem.toolTip = nil
        if updater.checking {
            checkedItem.title = "Checking for updates…"
        } else if let error = updater.checkError {
            checkedItem.title = "Couldn't check for updates"
            checkedItem.toolTip = error
        } else if let latest = updater.latest, let at = updater.checkedAt {
            checkedItem.title = "Newest is \(latest.version), checked \(ago(at, now: Date()))"
        } else {
            checkedItem.title = "Not checked yet"
        }
        checkItem.isEnabled = !updater.checking
        stableItem.state = updater.track == .stable ? .on : .off
        developmentItem.state = updater.track == .development ? .on : .off
    }

    private func dashboardVersionLine() -> String {
        if dashboard.isAttached {
            guard case .status(let status) = reading, let version = status.version else { return "Dashboard run by another process" }
            return "Dashboard \(version), run by another process"
        }
        guard let copy = dashboard.copy else { return "Dashboard starting…" }
        guard let version = copy.version else { return "Dashboard from a checkout" }
        return version.isEmpty ? "Dashboard of unknown version" : "Dashboard \(version)"
    }

    private func updaterChanged() {
        refreshMenu()
        announceOffer()
    }

    /// A notification for each new version found, once.
    private func announceOffer() {
        guard let offer = currentOffer() else { return }
        let defaults = UserDefaults.standard
        if let version = offer.dashboard, updater.phase == .idle, defaults.string(forKey: notifiedDashboardKey) != version {
            defaults.set(version, forKey: notifiedDashboardKey)
            post(.dashboardAvailable(version: version))
        }
        if let version = offer.app, defaults.string(forKey: notifiedAppKey) != version {
            defaults.set(version, forKey: notifiedAppKey)
            post(.appAvailable(version: version, needed: offer.appNeeded))
        }
    }

    /// Restarts the dashboard into a downloaded update, on a fresh answer that says
    /// nothing in it is busy. Anything else that restarts it starts the update too.
    private func applyUpdate() {
        guard case .ready(let version) = updater.phase, restartingInto == nil, case .running = dashboard.state else { return }
        if dashboard.copy?.version == version {
            updater.started(dashboard.copy!)
            return
        }
        if case .status(let status) = reading, isBusy(status) { return }
        if case .nothing = reading { return }
        restartingInto = version
        dashboard.restart()
    }

    private func dashboardRefused(_ version: String) {
        updater.gaveUp(on: version)
        if restartingInto == version { restartingInto = nil }
        post(.dashboardRefused(version: version))
    }
}
