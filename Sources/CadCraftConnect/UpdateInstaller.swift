import AppKit
import Foundation

enum UpdateInstaller {
    private static let errorFileName = "update-install-error.txt"

    static func launchHelper(
        stagedApp: URL,
        temporaryDirectory: URL,
        expectedVersion: String
    ) throws {
        let bundleURL = Bundle.main.bundleURL.standardizedFileURL
        let helper = bundleURL.appendingPathComponent("Contents/Helpers/CadCraftConnectUpdater")
        guard bundleURL.lastPathComponent == "CadCraft Connect.app",
              FileManager.default.isExecutableFile(atPath: helper.path) else {
            throw UpdateInstallerError.helperMissing
        }

        let process = Process()
        process.executableURL = helper
        process.arguments = [
            "--install-update",
            stagedApp.path,
            bundleURL.path,
            String(ProcessInfo.processInfo.processIdentifier),
            temporaryDirectory.path,
            expectedVersion
        ]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
    }

    static func consumeInstallError() -> String? {
        let errorFile = applicationSupportDirectory().appendingPathComponent(errorFileName)
        guard FileManager.default.fileExists(atPath: errorFile.path) else { return nil }
        do {
            let message = try String(contentsOf: errorFile, encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            try FileManager.default.removeItem(at: errorFile)
            return message.isEmpty ? "The updater did not provide an error message." : message
        } catch {
            return "Could not read the previous update error: \(error.localizedDescription)"
        }
    }

    private static func applicationSupportDirectory() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/CadCraft Connect", isDirectory: true)
    }
}

private enum UpdateInstallerError: LocalizedError {
    case helperMissing

    var errorDescription: String? {
        switch self {
        case .helperMissing:
            return "The bundled update installer is missing. Reinstall CadCraft Connect before updating."
        }
    }
}
