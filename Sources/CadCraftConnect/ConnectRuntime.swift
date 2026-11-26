import AppKit
import Combine
import Foundation
import Security

struct ConnectApproval: Identifiable {
    let id: String
    let clientName: String
    let redirectHost: String
    let trusted: Bool
    let matchCode: String

    init?(json: [String: Any]) {
        guard let id = json["id"] as? String,
              let clientName = json["clientName"] as? String,
              let redirectHost = json["redirectHost"] as? String,
              let matchCode = json["matchCode"] as? String else {
            return nil
        }
        self.id = id
        self.clientName = clientName
        self.redirectHost = redirectHost
        self.trusted = json["trusted"] as? Bool ?? false
        self.matchCode = matchCode
    }
}

struct ConnectZone: Identifiable, Decodable {
    let id: String
    let name: String
}

struct ConnectZonePrompt: Identifiable {
    let id: String
    let zones: [ConnectZone]
}

struct ConnectLogEntry: Identifiable {
    let id = UUID()
    let time: Date
    let message: String
}

@MainActor
final class ConnectRuntime: ObservableObject {
    @Published private(set) var status = "idle"
    @Published private(set) var statusDetail: String?
    @Published private(set) var connectorURL: String?
    @Published private(set) var approvals: [ConnectApproval] = []
    @Published private(set) var logs: [ConnectLogEntry] = []
    @Published var zonePrompt: ConnectZonePrompt?
    @Published var alertMessage: String?

    private var process: Process?
    private var inputPipe: Pipe?
    nonisolated(unsafe) private var outputBuffer = Data()
    private let outputQueue = DispatchQueue(label: "com.bigmanorange.CadCraftConnect.output")
    private var requests: [String: CheckedContinuation<Any?, Error>] = [:]
    private var terminationObserver: NSObjectProtocol?

    var isReady: Bool { status == "ready" }
    var isWorking: Bool {
        ["launching-cadcraft", "logging-in", "choosing-domain", "provisioning",
         "starting", "connecting"].contains(status)
    }

    func start() async {
        do {
            connectorURL = try await command("start") as? String
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    func stop() async {
        do {
            _ = try await command("stop")
            connectorURL = nil
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    func teardown() async {
        do {
            _ = try await command("teardown")
            connectorURL = nil
            approvals = []
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    func logout() async {
        do {
            _ = try await command("logout")
            connectorURL = nil
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    func disconnectAll() async {
        do {
            _ = try await command("disconnectAll")
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    func decide(_ approval: ConnectApproval, approve: Bool) async {
        do {
            let accepted = try await command(
                "decide",
                parameters: ["approvalId": approval.id, "approve": approve]
            ) as? Bool ?? false
            approvals.removeAll { $0.id == approval.id }
            if !accepted {
                alertMessage = "This authorization request has expired. Ask the client to try again."
            }
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    func selectZone(_ zone: ConnectZone, for prompt: ConnectZonePrompt) {
        respond(to: prompt.id, value: ["id": zone.id])
        zonePrompt = nil
    }

    func cancelZoneSelection(_ prompt: ConnectZonePrompt) {
        respond(to: prompt.id, value: NSNull())
        zonePrompt = nil
    }

    private func command(
        _ name: String,
        parameters: [String: Any] = [:]
    ) async throws -> Any? {
        try launchHostIfNeeded()
        let id = UUID().uuidString
        return try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Any?, Error>) in
            requests[id] = continuation
            var message: [String: Any] = [
                "type": "command",
                "id": id,
                "command": name
            ]
            parameters.forEach { message[$0.key] = $0.value }
            do {
                try write(message)
            } catch {
                requests.removeValue(forKey: id)
                continuation.resume(throwing: error)
            }
        }
    }

    private func launchHostIfNeeded() throws {
        if let process, process.isRunning { return }
        let resources = Bundle.main.resourceURL?.appendingPathComponent("connect")
        let bundledNode = resources?.appendingPathComponent("bin/node")
        let bundledHost = resources?.appendingPathComponent("dist/src/nativeHost.js")
        let bundledCloudflared = resources?.appendingPathComponent("bin/cloudflared")

        let executableURL: URL
        let hostURL: URL
        let workingDirectory: URL
        if let resources, let bundledNode, let bundledHost,
           FileManager.default.isExecutableFile(atPath: bundledNode.path),
           FileManager.default.fileExists(atPath: bundledHost.path) {
            executableURL = bundledNode
            hostURL = bundledHost
            workingDirectory = resources
        } else {
            let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
                .appendingPathComponent("cadcraft-connect")
            let host = root.appendingPathComponent("dist/src/nativeHost.js")
            guard FileManager.default.fileExists(atPath: host.path),
                  let node = Self.findExecutable(named: "node") else {
                throw RuntimeError.packagedRuntimeMissing
            }
            executableURL = URL(fileURLWithPath: node)
            hostURL = host
            workingDirectory = root
        }

        let child = Process()
        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        child.executableURL = executableURL
        child.arguments = [hostURL.path]
        child.currentDirectoryURL = workingDirectory
        child.standardInput = stdin
        child.standardOutput = stdout
        child.standardError = stderr
        var environment = ProcessInfo.processInfo.environment
        if let bundledCloudflared,
           FileManager.default.isExecutableFile(atPath: bundledCloudflared.path) {
            environment["CADCRAFT_BUNDLED_CLOUDFLARED"] = bundledCloudflared.path
        }
        child.environment = environment

        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            self?.outputQueue.async { [weak self] in
                self?.consume(data)
            }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            let message = String(decoding: data, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !message.isEmpty else { return }
            Task { @MainActor [weak self] in
                self?.appendLog(message)
            }
        }
        child.terminationHandler = { [weak self] process in
            Task { @MainActor [weak self] in
                self?.hostTerminated(status: process.terminationStatus)
            }
        }
        if let terminationObserver {
            NotificationCenter.default.removeObserver(terminationObserver)
        }
        terminationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: nil
        ) { _ in
            if child.isRunning { child.terminate() }
        }

        do {
            try child.run()
            process = child
            inputPipe = stdin
            try write([
                "type": "bootstrap",
                "key": try Self.keychainKey().base64EncodedString()
            ])
        } catch {
            child.terminate()
            process = nil
            inputPipe = nil
            throw error
        }
    }

    private func write(_ message: [String: Any]) throws {
        guard let inputPipe, process?.isRunning == true else {
            throw RuntimeError.hostNotRunning
        }
        var data = try JSONSerialization.data(withJSONObject: message)
        data.append(0x0A)
        try inputPipe.fileHandleForWriting.write(contentsOf: data)
    }

    private func respond(to id: String, value: Any) {
        do {
            try write(["type": "response", "id": id, "value": value])
        } catch {
            alertMessage = error.localizedDescription
        }
    }

    private nonisolated func consume(_ data: Data) {
        outputBuffer.append(data)
        while let newline = outputBuffer.firstRange(of: Data([0x0A])) {
            let line = Data(outputBuffer[..<newline.lowerBound])
            outputBuffer.removeSubrange(...newline.lowerBound)
            guard let object = try? JSONSerialization.jsonObject(with: line),
                  let message = object as? [String: Any] else { continue }
            Task { @MainActor [weak self] in
                self?.handle(message)
            }
        }
    }

    private func handle(_ message: [String: Any]) {
        switch message["type"] as? String {
        case "status":
            status = message["status"] as? String ?? status
            statusDetail = message["detail"] as? String
        case "log":
            appendLog(message["message"] as? String ?? "Connection event")
        case "approval":
            guard let json = message["approval"] as? [String: Any],
                  let approval = ConnectApproval(json: json),
                  !approvals.contains(where: { $0.id == approval.id }) else { return }
            approvals.append(approval)
        case "prompt":
            handlePrompt(message)
        case "response":
            guard let id = message["id"] as? String,
                  let continuation = requests.removeValue(forKey: id) else { return }
            if message["ok"] as? Bool == true {
                continuation.resume(returning: message["result"])
            } else {
                continuation.resume(
                    throwing: RuntimeError.service(
                        message["error"] as? String ?? "The connection service failed."
                    )
                )
            }
        case "error":
            alertMessage = message["message"] as? String ?? "The connection service stopped unexpectedly."
        default:
            break
        }
    }

    private func handlePrompt(_ message: [String: Any]) {
        guard let id = message["id"] as? String else { return }
        switch message["kind"] as? String {
        case "chooseZone":
            guard let data = try? JSONSerialization.data(withJSONObject: message["zones"] ?? []),
                  let zones = try? JSONDecoder().decode([ConnectZone].self, from: data),
                  !zones.isEmpty else {
                respond(to: id, value: NSNull())
                alertMessage = "Cloudflare returned no selectable domains."
                return
            }
            zonePrompt = ConnectZonePrompt(id: id, zones: zones)
        case "locateApp":
            let panel = NSOpenPanel()
            panel.title = "Choose CadCraft"
            panel.message = "Select the CadCraft app or its CADCraft executable."
            panel.directoryURL = URL(fileURLWithPath: "/Applications")
            panel.canChooseFiles = true
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = false
            panel.treatsFilePackagesAsDirectories = true
            guard panel.runModal() == .OK, let selected = panel.url else {
                respond(to: id, value: NSNull())
                return
            }
            let binary = selected.pathExtension == "app"
                ? selected.appendingPathComponent("Contents/MacOS/CADCraft")
                : selected
            guard FileManager.default.isExecutableFile(atPath: binary.path) else {
                respond(to: id, value: NSNull())
                alertMessage = "The selected item does not contain an executable named CADCraft."
                return
            }
            respond(to: id, value: binary.path)
        default:
            respond(to: id, value: NSNull())
        }
    }

    private func appendLog(_ message: String) {
        logs.append(ConnectLogEntry(time: Date(), message: message))
        if logs.count > 500 {
            logs.removeFirst(logs.count - 500)
        }
    }

    private func hostTerminated(status exitStatus: Int32) {
        process = nil
        inputPipe = nil
        if let terminationObserver {
            NotificationCenter.default.removeObserver(terminationObserver)
            self.terminationObserver = nil
        }
        let error = RuntimeError.hostExited(exitStatus)
        requests.values.forEach { $0.resume(throwing: error) }
        requests.removeAll()
        if status != "idle" && status != "error" {
            status = "error"
            statusDetail = error.localizedDescription
        }
    }

    private static func findExecutable(named name: String) -> String? {
        let paths = (ProcessInfo.processInfo.environment["PATH"] ?? "")
            .split(separator: ":")
            .map { URL(fileURLWithPath: String($0)).appendingPathComponent(name).path }
        return paths.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private static func keychainKey() throws -> Data {
        let service = "com.bigmanorange.CadCraftConnect.oauth-vault"
        let account = "master-key"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess, let key = result as? Data, key.count == 32 {
            return key
        }
        guard status == errSecItemNotFound else {
            throw RuntimeError.keychain(status)
        }

        var key = Data(count: 32)
        let randomStatus = key.withUnsafeMutableBytes { bytes in
            SecRandomCopyBytes(kSecRandomDefault, bytes.count, bytes.baseAddress!)
        }
        guard randomStatus == errSecSuccess else {
            throw RuntimeError.keychain(randomStatus)
        }
        var addQuery = query
        addQuery.removeValue(forKey: kSecReturnData as String)
        addQuery.removeValue(forKey: kSecMatchLimit as String)
        addQuery[kSecValueData as String] = key
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        if addStatus == errSecDuplicateItem {
            result = nil
            let retryStatus = SecItemCopyMatching(query as CFDictionary, &result)
            if retryStatus == errSecSuccess, let existing = result as? Data, existing.count == 32 {
                return existing
            }
            throw RuntimeError.keychain(retryStatus)
        }
        guard addStatus == errSecSuccess else {
            throw RuntimeError.keychain(addStatus)
        }
        return key
    }
}

private enum RuntimeError: LocalizedError {
    case packagedRuntimeMissing
    case hostNotRunning
    case hostExited(Int32)
    case keychain(OSStatus)
    case service(String)

    var errorDescription: String? {
        switch self {
        case .packagedRuntimeMissing:
            return "The bundled connection runtime is missing. Build or reinstall the complete CadCraft Connect app."
        case .hostNotRunning:
            return "The connection service is not running. Try connecting again."
        case .hostExited(let status):
            return "The connection service stopped (exit code \(status)). Try connecting again."
        case .keychain(let status):
            return "Could not access secure credential storage (Keychain error \(status))."
        case .service(let message):
            return message
        }
    }
}
