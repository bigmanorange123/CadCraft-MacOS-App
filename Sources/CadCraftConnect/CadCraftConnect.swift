import SwiftUI

@main
struct CadCraftConnect: App {
    @StateObject private var runtime = ConnectRuntime()

    var body: some Scene {
        WindowGroup("CadCraft Connect", id: "main") {
            ContentView(runtime: runtime)
        }

        MenuBarExtra("CadCraft Connect", systemImage: "bolt.fill") {
            MenuBarView(runtime: runtime)
        }
        .menuBarExtraStyle(.window)
    }
}
