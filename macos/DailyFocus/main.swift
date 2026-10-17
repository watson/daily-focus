// Daily Focus, the menu bar app: keeps the dashboard running and says how it is.

import AppKit

// Checked before AppKit is touched, so the build can run it with nobody logged in
// to a menu bar and without asking for notification permission.
if CommandLine.arguments.contains("--self-test") {
    exit(runSelfTest() ? 0 : 1)
}

// `--check-dashboard <bundle>`: whether this app would run a downloaded dashboard,
// and `--check-app <bundle>`, whether it would put a downloaded app in its place,
// for the build to ask of the bundles it signed.
for (option, identifier, verdict) in [
    ("--check-dashboard", dashboardIdentifier, "this app would run it"),
    ("--check-app", appIdentifier, "this app would put it in its place"),
] {
    guard let flag = CommandLine.arguments.firstIndex(of: option) else { continue }
    guard flag + 1 < CommandLine.arguments.count else {
        print("usage: Daily Focus \(option) <bundle>")
        exit(64)
    }
    let bundle = URL(fileURLWithPath: CommandLine.arguments[flag + 1])
    if let problem = signatureProblem(bundle: bundle, identifier: identifier, team: ownTeam) {
        print("\(bundle.path): refused, \(problem)")
        exit(1)
    }
    print("\(bundle.path): \(verdict)")
    exit(0)
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    // Info.plist says LSUIElement already; this covers a binary run outside its bundle.
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { app.run() }
}
