import AppKit
import SwiftUI

private enum AppPage: String, CaseIterable {
    case home = "Overview"
    case settings = "Security & setup"
    case logs = "Activity"

    var icon: String {
        switch self {
        case .home: return "square.grid.2x2"
        case .settings: return "lock.shield"
        case .logs: return "list.bullet.rectangle"
        }
    }
}

private enum AppTheme {
    static let background = Color(hex: 0x090B0D)
    static let panel = Color(hex: 0x111417)
    static let border = Color(hex: 0x252A30)
    static let muted = Color(hex: 0x929AA5)
    static let orange = Color(hex: 0xFF9D4D)
    static let green = Color(hex: 0x4DD79B)
    static let red = Color(hex: 0xFF7272)
}

struct ContentView: View {
    @ObservedObject var runtime: ConnectRuntime
    @ObservedObject var updater: AppUpdater
    @ObservedObject var launchAtLogin: LaunchAtLoginManager

    @State private var page: AppPage = .home
    @State private var confirmDisconnectAll = false
    @State private var confirmTeardown = false
    @AppStorage("cadcraft-connect.startup-permission-answered") private var startupPermissionAnswered = false

    var body: some View {
        VStack(spacing: 0) {
            header

            HStack(spacing: 0) {
                sidebar

                Rectangle()
                    .fill(AppTheme.border)
                    .frame(width: 1)

                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        pageHeading

                        switch page {
                        case .home:
                            overview
                        case .settings:
                            SecuritySetupPage(
                                runtime: runtime,
                                updater: updater,
                                launchAtLogin: launchAtLogin,
                                confirmDisconnectAll: $confirmDisconnectAll,
                                confirmTeardown: $confirmTeardown
                            )
                        case .logs:
                            ActivityPage(runtime: runtime)
                        }
                    }
                    .padding(32)
                    .frame(maxWidth: 1200, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .background(AppTheme.background)
        .foregroundStyle(.white)
        .preferredColorScheme(.dark)
        .tint(AppTheme.orange)
        .frame(minWidth: 1000, minHeight: 720)
        .sheet(item: $runtime.zonePrompt) { prompt in
            ZonePicker(prompt: prompt, runtime: runtime)
        }
        .alert(
            "CadCraft Connect",
            isPresented: Binding(
                get: { runtime.alertMessage != nil },
                set: { if !$0 { runtime.alertMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) { runtime.alertMessage = nil }
        } message: {
            Text(runtime.alertMessage ?? "")
        }
        .confirmationDialog(
            "Disconnect all Claude sessions?",
            isPresented: $confirmDisconnectAll,
            titleVisibility: .visible
        ) {
            Button("Disconnect all sessions", role: .destructive) {
                Task { await runtime.disconnectAll() }
            }
        } message: {
            Text("All existing Claude access tokens will stop working. You can approve new sessions later.")
        }
        .confirmationDialog(
            "Remove the Cloudflare tunnel and DNS record?",
            isPresented: $confirmTeardown,
            titleVisibility: .visible
        ) {
            Button("Remove tunnel and DNS record", role: .destructive) {
                Task { await runtime.teardown() }
            }
        } message: {
            Text("This removes the tunnel and its CadCraft DNS record from Cloudflare. You will need to set up a new connection afterward.")
        }
    }

    private var header: some View {
        HStack {
            Text("CAD CRAFT CONNECT")
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.8)
                .foregroundStyle(AppTheme.muted)

            Spacer()

            Badge(
                text: runtime.status.uppercased().replacingOccurrences(of: "-", with: " "),
                color: statusColor
            )
        }
        .padding(.horizontal, 20)
        .frame(height: 42)
        .background(Color(hex: 0x1A1D21))
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "square.stack.3d.up.fill")
                    .font(.title2)
                    .foregroundStyle(AppTheme.orange)

                VStack(alignment: .leading, spacing: 2) {
                    Text("CAD CRAFT")
                        .font(.system(size: 12, weight: .bold))
                    Text("CONNECT")
                        .font(.system(size: 9))
                        .tracking(2)
                        .foregroundStyle(AppTheme.muted)
                }
            }
            .padding(.bottom, 20)

            ForEach(AppPage.allCases, id: \.self) { item in
                Button {
                    page = item
                } label: {
                    Label(item.rawValue, systemImage: item.icon)
                        .font(.system(size: 13, weight: .medium))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(13)
                        .background(page == item ? AppTheme.orange.opacity(0.12) : .clear)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(page == item ? .white : AppTheme.muted)
            }

            Spacer()

            Text("CLOUDFLARE TUNNEL")
                .font(.system(size: 9, weight: .medium))
                .tracking(1.1)
                .foregroundStyle(AppTheme.muted)

            HStack(spacing: 8) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 7, height: 7)
                Text(statusDescription)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.white.opacity(0.85))
            }
        }
        .padding(20)
        .frame(width: 205)
        .background(Color(hex: 0x0D1013))
    }

    private var pageHeading: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(section)
                .font(.system(size: 10, weight: .semibold))
                .tracking(1.2)
                .foregroundStyle(AppTheme.orange)

            Text(title)
                .font(.system(size: 30, weight: .bold))

            Text(subtitle)
                .font(.system(size: 13))
                .foregroundStyle(AppTheme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var section: String {
        switch page {
        case .home: return "WORKSPACE / CONNECTION"
        case .settings: return "WORKSPACE / AUTHENTICATION"
        case .logs: return "WORKSPACE / ACTIVITY"
        }
    }

    private var title: String {
        switch page {
        case .home: return runtime.isReady ? "Your connector is online." : "Connect CadCraft to Claude."
        case .settings: return "Security and setup"
        case .logs: return "Live activity"
        }
    }

    private var subtitle: String {
        switch page {
        case .home:
            return "Set up a Cloudflare tunnel, then approve every client from this Mac."
        case .settings:
            return "Manage the Cloudflare sign-in, client approvals, and bundled runtime."
        case .logs:
            return "Connection status and tunnel events from this app session."
        }
    }

    private var overview: some View {
        VStack(spacing: 20) {
            if !startupPermissionAnswered && !launchAtLogin.isEnabled {
                startupPermissionPrompt
            }

            Panel {
                HStack(spacing: 24) {
                    Image(systemName: runtime.isReady ? "network" : "lock.shield")
                        .font(.system(size: 42, weight: .light))
                        .foregroundStyle(runtime.isReady ? AppTheme.green : AppTheme.orange)
                        .frame(width: 92, height: 92)
                        .background((runtime.isReady ? AppTheme.green : AppTheme.orange).opacity(0.09))
                        .clipShape(RoundedRectangle(cornerRadius: 20))

                    VStack(alignment: .leading, spacing: 10) {
                        Badge(text: statusDescription.uppercased(), color: statusColor)
                        Text(runtime.isReady ? "Cloudflare tunnel is active" : "Secure setup, one step at a time")
                            .font(.title2.bold())
                        Text(statusMessage)
                            .font(.system(size: 13))
                            .foregroundStyle(AppTheme.muted)
                            .fixedSize(horizontal: false, vertical: true)

                        HStack(spacing: 10) {
                            if runtime.isReady {
                                Button {
                                    Task { await runtime.stop() }
                                } label: {
                                    Label("Stop connection", systemImage: "stop.fill")
                                }
                                .buttonStyle(.bordered)
                            } else {
                                Button {
                                    Task { await runtime.start() }
                                } label: {
                                    Label(
                                        runtime.isWorking ? "Setting up…" : "Connect Cloudflare",
                                        systemImage: runtime.isWorking ? "hourglass" : "bolt.fill"
                                    )
                                }
                                .buttonStyle(.borderedProminent)
                                .disabled(runtime.isWorking)
                            }

                            if let url = runtime.connectorURL {
                                Button("Copy connector URL") {
                                    NSPasteboard.general.clearContents()
                                    NSPasteboard.general.setString(url, forType: .string)
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                    }

                    Spacer(minLength: 0)
                }
            }

            if runtime.isReady, let url = runtime.connectorURL {
                Panel {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Claude connector URL")
                            .font(.headline)
                        Text(url)
                            .font(.system(size: 12, design: .monospaced))
                            .textSelection(.enabled)
                            .foregroundStyle(AppTheme.green)
                        Text("Add this URL in Claude → Settings → Connectors → Add custom connector.")
                            .font(.caption)
                            .foregroundStyle(AppTheme.muted)
                    }
                }
            }

            if let detail = runtime.statusDetail, !detail.isEmpty {
                Panel {
                    Label(detail, systemImage: "info.circle")
                        .font(.system(size: 12))
                        .foregroundStyle(AppTheme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            if !runtime.approvals.isEmpty {
                approvalQueue
            }

            HStack(spacing: 14) {
                Metric("CONNECTION", runtime.isReady ? "Online" : "Offline", statusDescription, color: statusColor)
                Metric("PENDING APPROVALS", "\(runtime.approvals.count)", "Each request needs your decision", color: runtime.approvals.isEmpty ? AppTheme.muted : AppTheme.orange)
                Metric("ACTIVITY EVENTS", "\(runtime.logs.count)", "Since this app was opened", color: AppTheme.green)
            }

            HStack(alignment: .top, spacing: 20) {
                Panel {
                    VStack(alignment: .leading, spacing: 16) {
                        HStack {
                            Text("Recent activity")
                                .font(.headline)
                            Spacer()
                            Button("View all") { page = .logs }
                                .buttonStyle(.plain)
                                .foregroundStyle(AppTheme.orange)
                        }

                        if runtime.logs.suffix(4).isEmpty {
                            Text("Connection events will appear here.")
                                .font(.system(size: 12))
                                .foregroundStyle(AppTheme.muted)
                        } else {
                            ForEach(runtime.logs.suffix(4).reversed()) { event in
                                HStack(alignment: .top, spacing: 12) {
                                    Text(event.time.formatted(date: .omitted, time: .standard))
                                        .font(.system(size: 10, design: .monospaced))
                                        .foregroundStyle(AppTheme.muted)
                                    Text(event.message)
                                        .font(.system(size: 12))
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                    }
                }

                Panel {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Connection details")
                            .font(.headline)
                        detail("BRIDGE", "127.0.0.1:7391")
                        detail("STUDIO MCP", "Authenticated loopback")
                        detail("AUTH CALLBACK", "127.0.0.1:38472")
                        detail("CREDENTIALS", "Encrypted with macOS Keychain")
                    }
                }
                .frame(width: 290)
            }
        }
    }

    private var startupPermissionPrompt: some View {
        Panel {
            HStack(spacing: 16) {
                Image(systemName: "power.circle")
                    .font(.system(size: 28))
                    .foregroundStyle(AppTheme.orange)
                VStack(alignment: .leading, spacing: 5) {
                    Text("Start CadCraft Connect at login?")
                        .font(.headline)
                    Text("You can change this anytime in Security & setup.")
                        .font(.system(size: 12))
                        .foregroundStyle(AppTheme.muted)
                }
                Spacer()
                Button("Not now") {
                    startupPermissionAnswered = true
                }
                .buttonStyle(.bordered)
                Button("Enable") {
                    launchAtLogin.setEnabled(true)
                    startupPermissionAnswered = true
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }

    private var approvalQueue: some View {
        Panel {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text("Authorization requests")
                        .font(.headline)
                    Spacer()
                    Badge(text: "REVIEW EACH REQUEST", color: AppTheme.orange)
                }

                ForEach(runtime.approvals) { approval in
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(approval.clientName)
                                    .font(.system(size: 14, weight: .semibold))
                                Text("Redirects to \(approval.redirectHost)")
                                    .font(.system(size: 11))
                                    .foregroundStyle(AppTheme.muted)
                            }
                            Spacer()
                            Badge(
                                text: approval.trusted ? "RECOGNIZED CLAUDE" : "UNRECOGNIZED CLIENT",
                                color: approval.trusted ? AppTheme.green : AppTheme.red
                            )
                        }

                        HStack(spacing: 12) {
                            Text("Confirm the browser code matches:")
                                .font(.system(size: 11))
                                .foregroundStyle(AppTheme.muted)
                            Text(approval.matchCode)
                                .font(.system(size: 18, weight: .bold, design: .monospaced))
                                .tracking(2)
                                .textSelection(.enabled)
                        }

                        HStack {
                            Text("Approving grants this client access to CadCraft tools.")
                                .font(.system(size: 11))
                                .foregroundStyle(AppTheme.muted)
                            Spacer()
                            Button("Deny", role: .destructive) {
                                Task { await runtime.decide(approval, approve: false) }
                            }
                            .buttonStyle(.bordered)
                            Button("Approve") {
                                Task { await runtime.decide(approval, approve: true) }
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    }
                    .padding(.vertical, 8)

                    if approval.id != runtime.approvals.last?.id {
                        Divider()
                    }
                }
            }
        }
    }

    private var statusColor: Color {
        if runtime.isReady { return AppTheme.green }
        if runtime.status == "error" { return AppTheme.red }
        if runtime.isWorking { return AppTheme.orange }
        return AppTheme.muted
    }

    private var statusDescription: String {
        if runtime.isReady { return "Connected" }
        if runtime.status == "error" { return "Needs attention" }
        switch runtime.status {
        case "launching-studio": return "Opening CadCraft Studio"
        case "logging-in": return "Signing in"
        case "choosing-domain": return "Choose domain"
        case "provisioning": return "Creating tunnel"
        case "starting": return "Starting bridge"
        case "connecting": return "Connecting tunnel"
        default: break
        }
        if runtime.isWorking { return "Setting up" }
        return "Not connected"
    }

    private var statusMessage: String {
        if let detail = runtime.statusDetail, !detail.isEmpty { return detail }
        if runtime.isReady {
            return "The authenticated bridge is running. New Claude clients will wait for your approval here."
        }
        switch runtime.status {
        case "launching-studio":
            return "An agent requested a tool. Opening CadCraft Studio and waiting for its secure connection."
        case "logging-in":
            return "Complete Cloudflare sign-in in your browser and return here."
        case "choosing-domain":
            return "Choose the Cloudflare domain that should host your connector."
        case "provisioning":
            return "Creating the Cloudflare tunnel and DNS record."
        case "starting":
            return "Starting the local authenticated bridge."
        case "connecting":
            return "Waiting for the Cloudflare tunnel to connect."
        default:
            break
        }
        return "Sign in to Cloudflare and set up the tunnel. CadCraft Studio opens only when an agent requests a tool."
    }

    private func detail(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.system(size: 9, weight: .medium))
                .tracking(1)
                .foregroundStyle(AppTheme.muted)
            Text(value)
                .font(.system(size: 12))
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct SecuritySetupPage: View {
    @ObservedObject var runtime: ConnectRuntime
    @ObservedObject var updater: AppUpdater
    @ObservedObject var launchAtLogin: LaunchAtLoginManager
    @Binding var confirmDisconnectAll: Bool
    @Binding var confirmTeardown: Bool

    var body: some View {
        VStack(spacing: 20) {
            Panel {
                VStack(alignment: .leading, spacing: 18) {
                    Label("Cloudflare account", systemImage: "person.crop.circle.badge.checkmark")
                        .font(.headline)
                    Text("Cloudflare sign-in uses the system browser with OAuth authorization code + PKCE. The saved login is encrypted locally with a key stored in macOS Keychain.")
                        .font(.system(size: 12))
                        .foregroundStyle(AppTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack {
                        Badge(
                            text: runtime.isReady ? "TUNNEL CONNECTED" : "SIGN-IN STARTS ON CONNECT",
                            color: runtime.isReady ? AppTheme.green : AppTheme.muted
                        )
                        Spacer()
                        if runtime.isReady {
                            Button("Stop connection") {
                                Task { await runtime.stop() }
                            }
                            .buttonStyle(.bordered)
                        } else {
                            Button("Sign in and connect") {
                                Task { await runtime.start() }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(runtime.isWorking)
                        }
                        Button("Sign out of Cloudflare") {
                            Task { await runtime.logout() }
                        }
                        .buttonStyle(.bordered)
                        .disabled(runtime.isWorking)
                    }
                }
            }

            Panel {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Start at login")
                        .font(.headline)
                    Text(launchAtLogin.statusMessage)
                        .font(.system(size: 12))
                        .foregroundStyle(AppTheme.muted)
                    if let error = launchAtLogin.errorMessage {
                        Text(error)
                            .font(.system(size: 11))
                            .foregroundStyle(AppTheme.red)
                    }
                    HStack {
                        if launchAtLogin.requiresApproval {
                            Button("Open Login Items Settings") {
                                launchAtLogin.openLoginItemsSettings()
                            }
                            .buttonStyle(.bordered)
                        } else {
                            Button(launchAtLogin.isEnabled ? "Disable" : "Enable at Login") {
                                launchAtLogin.setEnabled(!launchAtLogin.isEnabled)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            Panel {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Software updates")
                        .font(.headline)
                    Text("Current version: v\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0")")
                        .font(.system(size: 11))
                        .foregroundStyle(AppTheme.muted)
                    Text(updater.message)
                        .font(.system(size: 12))
                        .foregroundStyle(updater.isUpdateAvailable ? AppTheme.orange : AppTheme.muted)
                        .textSelection(.enabled)
                    HStack {
                        Button(updater.isChecking ? "Checking…" : "Check for Updates") {
                            Task { await updater.checkNow() }
                        }
                        .buttonStyle(.bordered)
                        .disabled(updater.isChecking)
                        if let url = updater.downloadURL {
                            Button("Download Update") {
                                NSWorkspace.shared.open(url)
                            }
                            .buttonStyle(.borderedProminent)
                        }
                        if updater.isUpdateAvailable, let url = updater.releaseURL {
                            Button("Release Notes") {
                                NSWorkspace.shared.open(url)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            Panel {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Claude client authorization")
                        .font(.headline)
                    securityRow(
                        "Approval is always manual",
                        "Every new client must be approved from this app."
                    )
                    securityRow(
                        "Match the browser code",
                        "Approve only when the six-digit code matches the browser request."
                    )
                    securityRow(
                        "Unknown clients are highlighted",
                        "Unrecognized redirect addresses are marked as unsafe; deny requests you do not recognize."
                    )
                    securityRow(
                        "Short-lived, rotated tokens",
                        "Access tokens expire after one hour. Refresh-token reuse revokes that grant."
                    )
                    Divider()
                    HStack {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Revoke active sessions")
                                .font(.system(size: 13, weight: .medium))
                            Text("Sign out every previously approved Claude session.")
                                .font(.system(size: 11))
                                .foregroundStyle(AppTheme.muted)
                        }
                        Spacer()
                        Button("Disconnect all sessions", role: .destructive) {
                            confirmDisconnectAll = true
                        }
                        .buttonStyle(.bordered)
                        .disabled(!runtime.isReady)
                    }
                }
            }

            Panel {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Packaged app")
                        .font(.headline)
                    Text("The distributed app includes its Node runtime, service dependencies, and cloudflared. End users do not need to install Node, npm packages, or cloudflared separately.")
                        .font(.system(size: 12))
                        .foregroundStyle(AppTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                    Divider()
                    HStack {
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Cloudflare resources")
                                .font(.system(size: 13, weight: .medium))
                            Text("Remove the tunnel and DNS record created for this connector.")
                                .font(.system(size: 11))
                                .foregroundStyle(AppTheme.muted)
                        }
                        Spacer()
                        Button("Remove tunnel…", role: .destructive) {
                            confirmTeardown = true
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
        }
    }

    private func securityRow(_ title: String, _ description: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "checkmark.shield.fill")
                .foregroundStyle(AppTheme.green)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 12, weight: .medium))
                Text(description)
                    .font(.system(size: 11))
                    .foregroundStyle(AppTheme.muted)
            }
        }
    }
}

private struct ActivityPage: View {
    @ObservedObject var runtime: ConnectRuntime
    @State private var search = ""

    private var events: [ConnectLogEntry] {
        guard !search.isEmpty else { return runtime.logs.reversed() }
        return runtime.logs.reversed().filter {
            $0.message.localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        VStack(spacing: 20) {
            HStack(spacing: 14) {
                Metric("SERVICE", runtime.status, "Current connection state", color: runtime.isReady ? AppTheme.green : AppTheme.orange)
                Metric("EVENTS", "\(runtime.logs.count)", "Kept for this app session", color: AppTheme.green)
                Metric("APPROVALS", "\(runtime.approvals.count)", "Waiting for your decision", color: AppTheme.orange)
            }

            Panel {
                VStack(alignment: .leading, spacing: 18) {
                    HStack {
                        Text("Connection event stream")
                            .font(.headline)
                        Spacer()
                        TextField("Search activity…", text: $search)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 240)
                    }

                    HStack {
                        Text("TIME")
                            .frame(width: 150, alignment: .leading)
                        Text("EVENT")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(AppTheme.muted)

                    Divider()

                    if events.isEmpty {
                        Text(search.isEmpty ? "No connection events yet." : "No events match your search.")
                            .foregroundStyle(AppTheme.muted)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 28)
                    } else {
                        ForEach(events) { event in
                            HStack(alignment: .top, spacing: 14) {
                                Text(event.time.formatted(date: .numeric, time: .standard))
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(AppTheme.muted)
                                    .frame(width: 150, alignment: .leading)
                                Text(event.message)
                                    .font(.system(size: 12))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .textSelection(.enabled)
                            }
                            .padding(.vertical, 4)
                        }
                    }

                    Divider()
                    Text("Activity is stored in memory and cleared when the app closes.")
                        .font(.caption)
                        .foregroundStyle(AppTheme.muted)
                }
            }
        }
    }
}

private struct ZonePicker: View {
    let prompt: ConnectZonePrompt
    @ObservedObject var runtime: ConnectRuntime

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Choose a Cloudflare domain")
                .font(.title2.bold())
            Text("A connector subdomain will be created on the domain you choose.")
                .font(.system(size: 12))
                .foregroundStyle(AppTheme.muted)

            ForEach(prompt.zones) { zone in
                Button {
                    runtime.selectZone(zone, for: prompt)
                } label: {
                    HStack {
                        Text(zone.name)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .foregroundStyle(AppTheme.muted)
                    }
                    .padding(12)
                    .background(AppTheme.panel)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
            }

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) {
                    runtime.cancelZoneSelection(prompt)
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(24)
        .frame(width: 420)
        .background(AppTheme.background)
    }
}

private struct Panel<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(22)
            .background(AppTheme.panel)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(AppTheme.border, lineWidth: 1)
            }
    }
}

private struct Metric: View {
    let title: String
    let value: String
    let subtitle: String
    let color: Color

    init(_ title: String, _ value: String, _ subtitle: String, color: Color) {
        self.title = title
        self.value = value
        self.subtitle = subtitle
        self.color = color
    }

    var body: some View {
        Panel {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(title)
                        .font(.system(size: 9, weight: .medium))
                        .tracking(0.7)
                        .foregroundStyle(AppTheme.muted)
                    Spacer(minLength: 2)
                    Circle()
                        .fill(color)
                        .frame(width: 6, height: 6)
                }
                Text(value)
                    .font(.system(size: 22, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text(subtitle)
                    .font(.system(size: 10))
                    .foregroundStyle(AppTheme.muted)
                    .lineLimit(2)
            }
        }
    }
}

private struct Badge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 8, weight: .semibold))
            .tracking(0.4)
            .foregroundStyle(color)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }
}

private extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}
