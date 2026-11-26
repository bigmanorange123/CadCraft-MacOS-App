import SwiftUI

@main
struct CadCraftConnect: App {
    @StateObject private var runtime = ConnectRuntime()
    @StateObject private var updater = AppUpdater()
    @StateObject private var launchAtLogin = LaunchAtLoginManager()

    var body: some Scene {
        WindowGroup("CadCraft Connect", id: "main") {
            ContentView(runtime: runtime, updater: updater, launchAtLogin: launchAtLogin)
                .task { await updater.checkAutomatically() }
        }

        MenuBarExtra("CadCraft Connect", systemImage: "bolt.fill") {
            MenuBarView(runtime: runtime)
        }
        .menuBarExtraStyle(.window)
    }
}
