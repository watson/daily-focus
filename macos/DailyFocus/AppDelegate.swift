// The menu, the icon, the status polling and the notifications. The server itself
// is `Dashboard`'s business; this file only shows what it and the server say.

import AppKit
import ServiceManagement
import UserNotifications

private let notifiedBriefKey = "notifiedBriefAt"
private let notifiedFailureKey = "notifiedFailedRunId"

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
    private var statusItem: NSStatusItem?
    private let menu = NSMenu()
    private let statusLineItem = NSMenuItem()
    private let attachedItem = NSMenuItem()
    private let openItem = NSMenuItem(title: "Open Daily Focus", action: nil, keyEquivalent: "o")
    private let briefItem = NSMenuItem(title: "Write a Fresh Brief", action: nil, keyEquivalent: "")
    private let nodeItem = NSMenuItem(title: "Download Node.js…", action: nil, keyEquivalent: "")
    private let loginItem = NSMenuItem(title: "Open at Login", action: nil, keyEquivalent: "")
    private let restartItem = NSMenuItem(title: "Restart Dashboard", action: nil, keyEquivalent: "")
    private let logItem = NSMenuItem(title: "Show Log", action: nil, keyEquivalent: "")
    private let quitItem = NSMenuItem(title: "Quit Daily Focus", action: nil, keyEquivalent: "q")

    private var reading: Reading = .nothing
    private var readingFrom: URL?
    private var firstPoll = true
    private var polling = false
    private var pollAgain = false
    private var pollTimer: DispatchSourceTimer?
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
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 30, repeating: 30)
        timer.setEventHandler { [weak self] in self?.poll() }
        timer.resume()
        pollTimer = timer

        refreshMenu()
        dashboard.start()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        pollTimer?.cancel()
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

        for (menuItem, action) in [
            (openItem, #selector(openDashboard)),
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

        for menuItem in [statusLineItem, attachedItem, openItem, briefItem, nodeItem, NSMenuItem.separator(),
                         loginItem, restartItem, logItem, NSMenuItem.separator(), quitItem] {
            menu.addItem(menuItem)
        }
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
        briefItem.isEnabled = canWriteBrief
        switch state {
        case .attached, .preparing, .stopping, .stopped: restartItem.isEnabled = false
        default: restartItem.isEnabled = true
        }
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
            case .nothing: return dashboard.isAttached ? "Run by another process" : "Starting…"
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
        refreshMenu()
        poll()
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
        }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async {
            self.openDashboard()
            completionHandler()
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
}
