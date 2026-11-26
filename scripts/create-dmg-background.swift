import AppKit
import Foundation

guard CommandLine.arguments.count == 3 else {
    fputs("Usage: create-dmg-background.swift <output.png> <AppIcon.icns>\n", stderr)
    exit(2)
}

let outputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let iconURL = URL(fileURLWithPath: CommandLine.arguments[2])
let width = 750
let height = 500
let bounds = NSRect(x: 0, y: 0, width: width, height: height)
let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: width,
    pixelsHigh: height,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
)
guard let icon = NSImage(contentsOf: iconURL) else {
    fputs("Could not load app icon: \(iconURL.path)\n", stderr)
    exit(1)
}
guard let bitmap else {
    fputs("Could not allocate the DMG background bitmap.\n", stderr)
    exit(1)
}

guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fputs("Could not create the DMG background graphics context.\n", stderr)
    exit(1)
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.imageInterpolation = .high

NSGradient(colors: [
    NSColor(red: 0.075, green: 0.094, blue: 0.12, alpha: 1),
    NSColor(red: 0.035, green: 0.047, blue: 0.063, alpha: 1),
])?.draw(in: bounds, angle: -90)

NSColor(calibratedRed: 1, green: 0.49, blue: 0.22, alpha: 0.09).setFill()
NSBezierPath(ovalIn: NSRect(x: 555, y: 280, width: 310, height: 310)).fill()

for x in stride(from: 465.0, through: 710.0, by: 24.0) {
    for y in stride(from: 285.0, through: 475.0, by: 24.0) {
        NSColor(calibratedWhite: 1, alpha: 0.075).setFill()
        NSBezierPath(ovalIn: NSRect(x: x, y: y, width: 2, height: 2)).fill()
    }
}

icon.draw(in: NSRect(x: 46, y: 418, width: 48, height: 48))

func draw(_ text: String, x: CGFloat, y: CGFloat, font: NSFont, color: NSColor) {
    (text as NSString).draw(
        at: NSPoint(x: x, y: y),
        withAttributes: [.font: font, .foregroundColor: color]
    )
}

let titleColor = NSColor(calibratedWhite: 0.96, alpha: 1)
let secondaryColor = NSColor(calibratedWhite: 0.68, alpha: 1)
let accentColor = NSColor(calibratedRed: 1, green: 0.49, blue: 0.22, alpha: 1)

draw("CADCRAFT CONNECT", x: 108, y: 433, font: .systemFont(ofSize: 23, weight: .bold), color: titleColor)
draw("A secure bridge to your CadCraft workspace", x: 109, y: 411, font: .systemFont(ofSize: 13), color: secondaryColor)

let accentRule = NSBezierPath()
accentRule.lineWidth = 2
accentColor.setStroke()
accentRule.move(to: NSPoint(x: 47, y: 383))
accentRule.line(to: NSPoint(x: 132, y: 383))
accentRule.stroke()

draw("INSTALL", x: 47, y: 347, font: .systemFont(ofSize: 11, weight: .bold), color: accentColor)
draw("Drag the app to Applications to install.", x: 47, y: 55, font: .systemFont(ofSize: 16, weight: .semibold), color: titleColor)
draw("Everything CadCraft Connect needs is bundled in the app.", x: 47, y: 33, font: .systemFont(ofSize: 12), color: secondaryColor)

let arrow = NSBezierPath()
arrow.lineWidth = 2
arrow.lineCapStyle = .round
secondaryColor.withAlphaComponent(0.65).setStroke()
arrow.move(to: NSPoint(x: 302, y: 225))
arrow.line(to: NSPoint(x: 435, y: 225))
arrow.move(to: NSPoint(x: 425, y: 234))
arrow.line(to: NSPoint(x: 435, y: 225))
arrow.line(to: NSPoint(x: 425, y: 216))
arrow.stroke()

NSGraphicsContext.restoreGraphicsState()

guard let pngData = bitmap.representation(using: .png, properties: [:]) else {
    fputs("Could not encode the DMG background as PNG.\n", stderr)
    exit(1)
}

do {
    try pngData.write(to: outputURL, options: .atomic)
} catch {
    fputs("Could not write DMG background: \(error.localizedDescription)\n", stderr)
    exit(1)
}
