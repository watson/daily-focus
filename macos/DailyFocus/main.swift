// Daily Focus, the menu bar app: keeps the dashboard running and says how it is.

import AppKit

// Checked before AppKit is touched, so the build can run it with nobody logged in
// to a menu bar and without asking for notification permission.
if CommandLine.arguments.contains("--self-test") {
    exit(runSelfTest() ? 0 : 1)
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    // Info.plist says LSUIElement already; this covers a binary run outside its bundle.
    app.setActivationPolicy(.accessory)
    withExtendedLifetime(delegate) { app.run() }
}
