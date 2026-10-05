// The menu bar icon. Template images throughout, so the menu bar colours them for
// light, dark and tinted menu bars alike; that is also why "needs a look" is a cut-out
// dot rather than a red one.

import AppKit

enum IconLook {
    case normal
    /// A stale brief, a failed run, setup to finish, or no way to start the dashboard.
    case attention
    /// The morning agent is writing a brief.
    case working
}

func menuBarIcon(_ look: IconLook) -> NSImage {
    let size = NSImage.SymbolConfiguration(pointSize: 15, weight: .regular)
    switch look {
    case .normal:
        return symbol("scope", size, "Daily Focus")
    case .working:
        return symbol("rays", size, "Daily Focus, the morning agent is writing a brief")
    case .attention:
        let base = symbol("scope", size, "Daily Focus")
        let image = NSImage(size: base.size, flipped: false) { rect in
            base.draw(in: rect)
            let diameter = rect.width * 0.34
            let dot = NSRect(x: rect.maxX - diameter, y: rect.maxY - diameter, width: diameter, height: diameter)
            // Clear a ring around the dot first, so it reads as a badge on the
            // symbol instead of a blot on its outline.
            NSGraphicsContext.current?.compositingOperation = .clear
            NSBezierPath(ovalIn: dot.insetBy(dx: -1.25, dy: -1.25)).fill()
            NSGraphicsContext.current?.compositingOperation = .sourceOver
            NSColor.black.setFill()
            NSBezierPath(ovalIn: dot).fill()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Daily Focus, needs a look"
        return image
    }
}

private func symbol(_ name: String, _ configuration: NSImage.SymbolConfiguration, _ description: String) -> NSImage {
    let image = NSImage(systemSymbolName: name, accessibilityDescription: description)?
        .withSymbolConfiguration(configuration) ?? NSImage(size: NSSize(width: 16, height: 16))
    image.isTemplate = true
    image.accessibilityDescription = description
    return image
}
