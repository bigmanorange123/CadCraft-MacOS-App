import Darwin
import Foundation

@main
enum CadCraftConnectUpdater {
    private static let bundleIdentifier = "com.bigmanorange.CadCraftConnect"
    private static let expectedAppName = "CadCraft Connect.app"

    static func main() {
        let arguments = CommandLine.arguments
        guard arguments.count == 7, arguments[1] == "--install-update",
              let parentPID = pid_t(arguments[4]) else {
            exit(64)
        }

        let stagedApp = URL(fileURLWithPath: arguments[2], isDirectory: true).standardizedFileURL
        let installedApp = URL(fileURLWithPath: arguments[3], isDirectory: true).standardizedFileURL
        let temporaryDirectory = URL(fileURLWithPath: arguments[5], isDirectory: true).standardizedFileURL
        let expectedVersion = arguments[6]

        do {
            try validatePaths(stagedApp, installedApp, temporaryDirectory)
            try waitForExit(parentPID)
            try replaceApp(stagedApp, installedApp, expectedVersion)
            do {
                try FileManager.default.removeItem(at: temporaryDirectory)
            } catch {
                NSLog("Could not remove temporary update files: %@", error.localizedDescription)
            }
            try run("/usr/bin/open", ["-a", installedApp.path])
        } catch {
            do {
                try writeInstallError(error.localizedDescription)
            } catch {
                NSLog("Could not save update error: %@", error.localizedDescription)
            }
            if FileManager.default.fileExists(atPath: installedApp.path) {
                do {
                    try run("/usr/bin/open", ["-a", installedApp.path])
                } catch {
                    NSLog("Could not reopen CadCraft Connect: %@", error.localizedDescription)
                }
            }
            exit(1)
        }
        exit(0)
    }

    private static func writeInstallError(_ message: String) throws {
        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/CadCraft Connect", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let errorFile = directory.appendingPathComponent("update-install-error.txt")
        try Data(message.utf8).write(to: errorFile, options: .atomic)
    }

    private static func validatePaths(_ stagedApp: URL, _ installedApp: URL, _ temporaryDirectory: URL) throws {
        let tempRoot = FileManager.default.temporaryDirectory.standardizedFileURL.path + "/"
        guard stagedApp.lastPathComponent == expectedAppName,
              stagedApp.deletingLastPathComponent() == temporaryDirectory,
              temporaryDirectory.path.hasPrefix(tempRoot),
              temporaryDirectory.lastPathComponent.hasPrefix("CadCraftConnect-update-"),
              installedApp.lastPathComponent == expectedAppName,
              FileManager.default.fileExists(atPath: installedApp.path) else {
            throw UpdateHelperError.invalidPaths
        }
        try verifyApp(stagedApp, expectedVersion: nil)
        try verifyApp(installedApp, expectedVersion: nil)
    }

    private static func waitForExit(_ pid: pid_t) throws {
        for _ in 0..<120 {
            if kill(pid, 0) != 0, errno == ESRCH { return }
            Thread.sleep(forTimeInterval: 0.25)
        }
        throw UpdateHelperError.appDidNotQuit
    }

    private static func replaceApp(_ stagedApp: URL, _ installedApp: URL, _ expectedVersion: String) throws {
        try verifyApp(stagedApp, expectedVersion: expectedVersion)
        let manager = FileManager.default
        let backup = installedApp.deletingLastPathComponent()
            .appendingPathComponent(".CadCraftConnect-backup-\(UUID().uuidString).app", isDirectory: true)
        try manager.moveItem(at: installedApp, to: backup)
        do {
            try run("/usr/bin/ditto", [stagedApp.path, installedApp.path])
            try verifyApp(installedApp, expectedVersion: expectedVersion)
        } catch {
            do {
                if manager.fileExists(atPath: installedApp.path) {
                    try manager.removeItem(at: installedApp)
                }
                try manager.moveItem(at: backup, to: installedApp)
            } catch {
                throw UpdateHelperError.rollbackFailed(error.localizedDescription)
            }
            throw error
        }
        do {
            try manager.removeItem(at: backup)
        } catch {
            NSLog("Could not remove the previous app backup: %@", error.localizedDescription)
        }
    }

    private static func verifyApp(_ app: URL, expectedVersion: String?) throws {
        let infoURL = app.appendingPathComponent("Contents/Info.plist")
        let data = try Data(contentsOf: infoURL)
        guard let info = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              info["CFBundleIdentifier"] as? String == bundleIdentifier,
              expectedVersion == nil || info["CFBundleShortVersionString"] as? String == expectedVersion,
              let executable = info["CFBundleExecutable"] as? String,
              !executable.isEmpty,
              URL(fileURLWithPath: executable).lastPathComponent == executable else {
            throw UpdateHelperError.invalidAppBundle
        }
        let executableURL = app.appendingPathComponent("Contents/MacOS").appendingPathComponent(executable)
        guard FileManager.default.isExecutableFile(atPath: executableURL.path) else {
            throw UpdateHelperError.invalidAppBundle
        }
        try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
    }

    private static func run(_ executable: String, _ arguments: [String]) throws {
        let process = Process()
        let errorPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = errorPipe
        try process.run()
        let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let detail = String(decoding: errorData, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw UpdateHelperError.commandFailed(executable, detail)
        }
    }
}

private enum UpdateHelperError: LocalizedError {
    case invalidPaths
    case appDidNotQuit
    case invalidAppBundle
    case rollbackFailed(String)
    case commandFailed(String, String)

    var errorDescription: String? {
        switch self {
        case .invalidPaths:
            return "The updater received an invalid app or temporary path."
        case .appDidNotQuit:
            return "CadCraft Connect did not quit in time for the update."
        case .invalidAppBundle:
            return "The replacement app failed bundle or signature verification."
        case .rollbackFailed(let detail):
            return "The update failed and restoring the previous app also failed: \(detail)"
        case .commandFailed(let command, let detail):
            return "\(URL(fileURLWithPath: command).lastPathComponent) failed: \(detail)"
        }
    }
}
