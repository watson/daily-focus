// Draws the app's icon and the disk image's background, for macos/build.sh.
//
//   artwork <output directory>
//
// Drawn here rather than kept as image files, so that changing them is a change to
// read in review, and so that every size is drawn sharp at that size instead of
// scaled down from one picture. Writes AppIcon.icns, and dmg-background.tiff, which
// holds the background at both screen densities so Finder picks the right one.

import AppKit

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write("usage: artwork <output directory>\n".data(using: .utf8)!)
    exit(64)
}
let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try? FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(
        srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
        green: CGFloat((hex >> 8) & 0xFF) / 255,
        blue: CGFloat(hex & 0xFF) / 255,
        alpha: alpha
    )
}

/// Draws `size` points of picture into a bitmap of `scale` pixels per point, and
/// writes it as a PNG whose resolution says which density it is.
func render(_ size: NSSize, scale: CGFloat, to url: URL, _ draw: (NSRect) -> Void) throws {
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: Int(size.width * scale),
        pixelsHigh: Int(size.height * scale),
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else { throw CocoaError(.fileWriteUnknown) }
    rep.size = size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    draw(NSRect(origin: .zero, size: size))
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { throw CocoaError(.fileWriteUnknown) }
    try png.write(to: url)
}

func run(_ tool: String, _ arguments: [String]) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: tool)
    process.arguments = arguments
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { throw CocoaError(.fileWriteUnknown) }
}

// MARK: The icon

// The dashboard's own blue, from public/style.css, darkening towards the bottom the
// way light falls on a macOS icon.
let iconTop = color(0x3B8EF0)
let iconBottom = color(0x1D5DB4)

/// A target: the thing a day is aimed at. Drawn on Apple's icon grid, a rounded
/// square inset from the canvas with room for its shadow.
func drawIcon(_ canvas: NSRect) {
    let side = canvas.width
    let unit = side / 1024
    let body = NSRect(x: 100 * unit, y: 100 * unit, width: 824 * unit, height: 824 * unit)
    let shape = NSBezierPath(roundedRect: body, xRadius: 185 * unit, yRadius: 185 * unit)

    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.28)
    shadow.shadowOffset = NSSize(width: 0, height: -10 * unit)
    shadow.shadowBlurRadius = 24 * unit
    shadow.set()
    iconBottom.setFill()
    shape.fill()
    NSGraphicsContext.restoreGraphicsState()

    NSGradient(starting: iconTop, ending: iconBottom)?.draw(in: shape, angle: -90)

    let center = NSPoint(x: body.midX, y: body.midY)
    let ring = { (radius: CGFloat, width: CGFloat, alpha: CGFloat) in
        let path = NSBezierPath(ovalIn: NSRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
        path.lineWidth = width * unit
        NSColor.white.withAlphaComponent(alpha).setStroke()
        path.stroke()
    }
    ring(290 * unit, 46, 0.38)
    ring(185 * unit, 46, 0.7)
    let dot = 78 * unit
    NSColor.white.setFill()
    NSBezierPath(ovalIn: NSRect(x: center.x - dot, y: center.y - dot, width: dot * 2, height: dot * 2)).fill()
}

let iconset = output.appendingPathComponent("AppIcon.iconset", isDirectory: true)
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let name = scale == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png"
        let side = CGFloat(points * scale)
        // Each size is drawn at its own pixel size, at one point per pixel, so the
        // file is exactly the size its name says.
        try render(NSSize(width: side, height: side), scale: 1, to: iconset.appendingPathComponent(name), drawIcon)
    }
}
try run("/usr/bin/iconutil", ["-c", "icns", iconset.path, "-o", output.appendingPathComponent("AppIcon.icns").path])
try FileManager.default.removeItem(at: iconset)

// MARK: The disk image's background

// The window macos/dmg-settings.py opens, and where it puts the two icons, in
// points from the top left: the app on the left, Applications on the right.
let window = NSSize(width: 660, height: 400)
let iconY: CGFloat = 180
let appX: CGFloat = 165
let applicationsX: CGFloat = 495

func drawBackground(_ canvas: NSRect) {
    NSGradient(starting: color(0xF8F9FB), ending: color(0xECEFF3))?.draw(in: canvas, angle: -90)

    // The arrow from one icon to the other, short of both so the icons stay clear.
    let y = window.height - iconY
    let from = NSPoint(x: appX + 92, y: y)
    let to = NSPoint(x: applicationsX - 92, y: y)
    let ink = color(0x9AA3AE)
    ink.setStroke()
    ink.setFill()
    let line = NSBezierPath()
    line.move(to: from)
    line.line(to: NSPoint(x: to.x - 14, y: to.y))
    line.lineWidth = 4
    line.lineCapStyle = .round
    line.stroke()
    let head = NSBezierPath()
    head.move(to: NSPoint(x: to.x, y: to.y))
    head.line(to: NSPoint(x: to.x - 20, y: to.y + 12))
    head.line(to: NSPoint(x: to.x - 20, y: to.y - 12))
    head.close()
    head.fill()

    // The app has no window and no Dock icon, so someone who opens it and sees
    // neither would think it did nothing. Say where it went.
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    let lines: [(String, NSFont, NSColor, CGFloat)] = [
        ("Drag Daily Focus to Applications", .systemFont(ofSize: 16, weight: .semibold), color(0x4A515A), 92),
        ("Then open it: it lives in the menu bar, not the Dock.", .systemFont(ofSize: 13), color(0x737B86), 66),
    ]
    for (text, font, ink, baseline) in lines {
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: ink, .paragraphStyle: paragraph]
        NSString(string: text).draw(in: NSRect(x: 0, y: baseline - 20, width: window.width, height: 24), withAttributes: attributes)
    }
}

let single = output.appendingPathComponent("dmg-background.png")
let double = output.appendingPathComponent("dmg-background@2x.png")
try render(window, scale: 1, to: single, drawBackground)
try render(window, scale: 2, to: double, drawBackground)
try run("/usr/bin/tiffutil", ["-cathidpicheck", single.path, double.path, "-out", output.appendingPathComponent("dmg-background.tiff").path])
try FileManager.default.removeItem(at: single)
try FileManager.default.removeItem(at: double)
print("drew \(output.appendingPathComponent("AppIcon.icns").path) and dmg-background.tiff")
