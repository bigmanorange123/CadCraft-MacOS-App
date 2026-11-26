import SwiftUI

struct MenuBarView: View {
    @ObservedObject var runtime: ConnectRuntime
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("CadCraft Connect")
                .font(.headline)

            Text("Status: \(runtime.statusDetail ?? runtime.status)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(3)

            if !runtime.approvals.isEmpty {
                Label(
                    "\(runtime.approvals.count) authorization request(s) waiting",
                    systemImage: "exclamationmark.shield"
                )
                .font(.caption)
                .foregroundStyle(.orange)
            }

            Divider()

            if runtime.isReady {
                Button("Stop connection") {
                    Task { await runtime.stop() }
                }
            } else {
                Button(runtime.isWorking ? "Setting up…" : "Connect Cloudflare") {
                    Task { await runtime.start() }
                }
                .disabled(runtime.isWorking)
            }

            if let url = runtime.connectorURL {
                Button("Copy connector URL") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(url, forType: .string)
                }
            }

            Button("Open app window") {
                openWindow(id: "main")
                NSApplication.shared.activate(ignoringOtherApps: true)
            }

            Divider()

            Button("Quit App") {
                NSApplication.shared.terminate(nil)
            }
            .keyboardShortcut("q")
        }
        .padding()
        .frame(width: 220)
    }
}
