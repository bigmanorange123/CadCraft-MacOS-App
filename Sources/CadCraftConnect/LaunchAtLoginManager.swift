import Combine
import ServiceManagement

@MainActor
final class LaunchAtLoginManager: ObservableObject {
    @Published private(set) var isEnabled = false
    @Published private(set) var requiresApproval = false
    @Published private(set) var statusMessage = ""
    @Published private(set) var errorMessage: String?

    init() {
        refresh()
    }

    func refresh() {
        switch SMAppService.mainApp.status {
        case .enabled:
            isEnabled = true
            requiresApproval = false
            statusMessage = "CadCraft Connect starts when you log in."
        case .requiresApproval:
            isEnabled = false
            requiresApproval = true
            statusMessage = "Allow CadCraft Connect in System Settings → General → Login Items."
        case .notRegistered:
            isEnabled = false
            requiresApproval = false
            statusMessage = "CadCraft Connect does not start automatically."
        case .notFound:
            isEnabled = false
            requiresApproval = false
            statusMessage = "Move CadCraft Connect to Applications before enabling this option."
        @unknown default:
            isEnabled = false
            requiresApproval = false
            statusMessage = "Could not read the login item status."
        }
    }

    func setEnabled(_ enabled: Bool) {
        errorMessage = nil
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            refresh()
        } catch {
            refresh()
            errorMessage = error.localizedDescription
        }
    }

    func openLoginItemsSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}
