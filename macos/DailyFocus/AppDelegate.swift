// The menu, the icon, the status polling and the notifications. The server itself
// is `Dashboard`'s business; this file only shows what it and the server say.

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
    private let aboutItem = NSMenuItem(title: "About Daily Focus", action: nil, keyEquivalent: "")
    private let quitItem = NSMenuItem(title: "Quit Daily Focus", action: nil, keyEquivalent: "q")
    private let updateItem = NSMenuItem()
    private let downloadItem = NSMenuItem()
    private let updatesItem = NSMenuItem(title: "Updates", action: nil, keyEquivalent: "")
    private let checkItem = NSMenuItem(title: "Check for Updates", action: nil, keyEquivalent: "")
    private let stableItem = NSMenuItem(title: "Stable Releases", action: nil, keyEquivalent: "")
    private let developmentItem = NSMenuItem(title: "Development Builds", action: nil, keyEquivalent: "")
    private let automaticItem = NSMenuItem(title: "Update Automatically", action: nil, keyEquivalent: "")

    private var reading: Reading = .nothing
    private var readingFrom: URL?
    private var firstPoll = true
    private var polling = false
    private var pollAgain = false
    private var pollTimer: DispatchSourceTimer?
    private var updateTimer: DispatchSourceTimer?
    /// The downloaded dashboard the app restarted the dashboard to run, until it runs.
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
        updater.discardStagedApp()
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
            (updateItem, #selector(installUpdate)),
            (openItem, #selector(openDashboard)),
            (settingsItem, #selector(openSettings)),
            (briefItem, #selector(writeBrief)),
            (nodeItem, #selector(downloadNode)),
            (loginItem, #selector(toggleOpenAtLogin)),
            (restartItem, #selector(restartDashboard)),
            (logItem, #selector(showLog)),
            (aboutItem, #selector(showAbout)),
            (quitItem, #selector(quit)),
        ] {
            menuItem.target = self
            menuItem.action = action
        }

        for menuItem in [statusLineItem, attachedItem, updateItem, openItem, settingsItem, briefItem, nodeItem,
                         NSMenuItem.separator(), loginItem, updatesItem, restartItem, logItem, NSMenuItem.separator(),
                         aboutItem, quitItem] {
            menu.addItem(menuItem)
        }
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
            if self.dashboard.url == nil {
                self.applyUpdate()
            } else {
                self.poll()
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
    /// such as the store and the port, go with it.
    private func relaunch(_ version: String) {
        var open: [String] = []
        for (key, value) in dashboard.environment.sorted(by: { $0.key < $1.key }) where key.hasPrefix("DAILY_FOCUS_") {
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

    @objc private func restartDashboard() {
        dashboard.restart()
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
            if case .status(let status) = result {
                tell(about: status)
                askAboutAutomaticUpdates(status)
            }
            refreshMenu()
            applyUpdate()
            updateUnattended()
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
        case .updateAvailable: identifier = "update"
        case .downloadAvailable: identifier = "update-download"
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
        return offer(latest: latest, running: running, appVersion: updater.appVersion, appSource: updater.appSource,
                     nodeVersion: dashboard.nodeVersion, canReplaceApp: ownReplacementProblem() == nil)
    }

    /// Why this copy can't put a newer app in its own place, or nil when it can.
    private func ownReplacementProblem() -> String? {
        guard updater.appSource != nil else { return "it was built from a checkout" }
        return replacementProblem(bundle: Bundle.main.bundleURL, team: ownTeam)
    }

    /// What installing `update` now would stop in the dashboard, if anything: either
    /// kind restarts it.
    private func wouldStop(_ update: Update) -> String? {
        // A dashboard another process runs carries on through the app's relaunch.
        if case .app = update, dashboard.isAttached { return nil }
        guard case .status(let status) = reading, isBusy(status) else { return nil }
        return busyWith(status)
    }

    /// What a downloaded update waits for before it goes in, to end "installs once …",
    /// or nil when it can go in now.
    private func holdUp(_ update: Update) -> String? {
        if consent == .now { return nil }
        if let busy = wouldStop(update) { return "\(busy) is done" }
        guard consent == .whenQuiet else { return nil }
        if case .app = update, dashboard.isAttached { return nil }
        guard case .status(let status) = reading, !mayUpdateUnattended(status, now: Date()) else { return nil }
        return "nobody has used the dashboard for half an hour"
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
    /// release holds one this copy can install, and nobody has used the dashboard
    /// for a while.
    private func updateUnattended() {
        guard updater.automatic, updater.phase == .idle, restartingInto == nil,
              let update = currentOffer()?.update, update.version != triedUnattended,
              case .status(let status) = reading, mayUpdateUnattended(status, now: Date())
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
    /// in the dashboard is busy, and for one that started on its own, nobody has used
    /// it for a while; or the user said to go ahead anyway. A dashboard goes in by
    /// restarting it into the update, which anything else that restarts it does too,
    /// and an app by swapping it in for this one and relaunching.
    private func applyUpdate() {
        guard case .ready(let update) = updater.phase, restartingInto == nil else { return }
        if case .dashboard(let version) = update {
            guard case .running = dashboard.state else { return }
            if dashboard.copy?.version == version {
                updater.started(dashboard.copy!)
                return
            }
        }
        if case .running = dashboard.state {
            if holdUp(update) != nil { return }
            if case .nothing = reading { return }
        }
        switch update {
        case .dashboard(let version):
            restartingInto = version
            dashboard.restart()
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
