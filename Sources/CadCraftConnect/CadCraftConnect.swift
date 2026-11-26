import SwiftUI

@main
struct CadCraftConnect: App {
    // Shared state between your desktop window and menu bar
    @State private var statusText: String = "Ready"

    var body: some Scene {
        // 1. Main Desktop Window
        WindowGroup("CadCraft Connect") {
            ContentView(statusText: $statusText)
        }

        // 2. Menu Bar Icon & Popover Window
        MenuBarExtra("CadCraft Connect", systemImage: "bolt.fill") {
            MenuBarView(statusText: $statusText)
        }
        .menuBarExtraStyle(.window) // Makes it a full SwiftUI popover instead of a plain text menu
    }
}
