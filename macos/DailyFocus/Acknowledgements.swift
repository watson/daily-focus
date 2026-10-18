// The licences of what the app carries that others wrote, in a window of the
// app's own: Node.js, and what the dashboard is built from. `macos/build.sh`
// writes them into one file in the app's resources; this only shows it.

import AppKit

/// What the window shows: the file the build wrote, or why there is none.
func acknowledgementsText(_ bundle: Bundle = .main) -> String? {
    guard let url = bundle.url(forResource: "Acknowledgements", withExtension: "txt") else { return nil }
    return try? String(contentsOf: url, encoding: .utf8)
}

/// One window, made on first use and brought back after that, closed or not.
final class AcknowledgementsWindow {
    private var window: NSWindow?

    func show() {
        let window = self.window ?? make()
        self.window = window
        window.makeKeyAndOrderFront(nil)
    }

    private func make() -> NSWindow {
        let window = KeyedWindow(
            contentRect: NSRect(x: 0, y: 0, width: 680, height: 600),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Acknowledgements"
        // Kept for the next time it's asked for, rather than made again.
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 420, height: 280)

        let scroll = NSTextView.scrollableTextView()
        let text = scroll.documentView as! NSTextView
        text.isEditable = false
        text.isSelectable = true
        // Some sixteen thousand lines: finding a name is the usual reason to look.
        text.usesFindBar = true
        text.isIncrementalSearchingEnabled = true
        text.textContainerInset = NSSize(width: 14, height: 14)
        text.textStorage?.setAttributedString(styled(
            acknowledgementsText() ?? "This copy of Daily Focus was built without its acknowledgements. "
                + "Every release has them; see https://github.com/watson/daily-focus."
        ))
        window.contentView = scroll
        window.center()
        // Where and how big it was last time, across launches.
        window.setFrameAutosaveName("Acknowledgements")
        return window
    }

    /// Monospaced, as licences are written to be read, in the system's text colour
    /// so it reads in dark mode, with every address a link to follow.
    private func styled(_ plain: String) -> NSAttributedString {
        let styled = NSMutableAttributedString(string: plain, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: NSFont.smallSystemFontSize, weight: .regular),
            .foregroundColor: NSColor.textColor,
        ])
        if let links = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
            for match in links.matches(in: plain, range: NSRange(location: 0, length: (plain as NSString).length)) {
                if let url = match.url { styled.addAttribute(.link, value: url, range: match.range) }
            }
        }
        return styled
    }
}

/// A window that takes the shortcuts a menu would give it. The app runs in the
/// menu bar with no main menu, which is where ⌘W, ⌘C, ⌘A and ⌘F come from in
/// other apps, so here the window answers them itself.
private final class KeyedWindow: NSWindow {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command else {
            return super.performKeyEquivalent(with: event)
        }
        switch event.charactersIgnoringModifiers {
        case "w":
            performClose(nil)
            return true
        case "c":
            return NSApp.sendAction(#selector(NSText.copy(_:)), to: nil, from: self)
        case "a":
            return NSApp.sendAction(#selector(NSText.selectAll(_:)), to: nil, from: self)
        case "f":
            // The text view reads which find action from its sender's tag.
            let find = NSMenuItem()
            find.tag = NSTextFinder.Action.showFindInterface.rawValue
            return NSApp.sendAction(#selector(NSResponder.performTextFinderAction(_:)), to: nil, from: find)
        default:
            return super.performKeyEquivalent(with: event)
        }
    }
}
