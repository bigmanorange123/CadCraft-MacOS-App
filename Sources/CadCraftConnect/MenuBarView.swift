import SwiftUI

struct MenuBarView: View {
    @Binding var statusText: String
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Quick Menu")
                .font(.headline)

            Text("Status: \(statusText)")
                .font(.subheadline)

            Divider()

            Button("Open Main Window") {
                NSApplication.shared.activate(ignoringOtherApps: true)
            }

            Button("Quit App") {
                NSApplication.shared.terminate(nil)
            }
            .keyboardShortcut("q")
        }
        .padding()
        .frame(width: 220)
    }
}
