import CryptoKit
import Foundation

struct StagedAppUpdate: Sendable {
    let directory: URL
    let app: URL
}

enum AppUpdateStager {
    private static let bundleIdentifier = "com.bigmanorange.CadCraftConnect"
    private static let maximumDownloadSize: Int64 = 200 * 1024 * 1024

    static func prepare(
        asset: ReleaseAsset,
        expectedVersion: String,
        releaseTag: String
    ) async throws -> StagedAppUpdate {
        guard asset.isVerifiable, asset.size <= maximumDownloadSize,
              asset.name == dmgAssetName,
              let digest = asset.digest?.dropFirst("sha256:".count).lowercased(),
              isExpectedReleaseURL(asset.downloadURL, releaseTag: releaseTag, assetName: asset.name) else {
            throw AppUpdateStagerError.invalidReleaseAsset
        }

        let fileManager = FileManager.default
        let directory = fileManager.temporaryDirectory
            .appendingPathComponent("CadCraftConnect-update-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: false)
        let mountPoint = directory.appendingPathComponent("mounted", isDirectory: true)
        var mounted = false

        do {
            var request = URLRequest(url: asset.downloadURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 900)
            request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
            request.setValue("CadCraftConnect-Updater", forHTTPHeaderField: "User-Agent")
            let (temporaryDownload, response) = try await URLSession.shared.download(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200,
                  let finalURL = response.url,
                  finalURL.scheme == "https",
                  isGitHubDownloadHost(finalURL.host ?? "") else {
                throw AppUpdateStagerError.downloadFailed
            }

            let dmg = directory.appendingPathComponent(asset.name)
            try fileManager.moveItem(at: temporaryDownload, to: dmg)
            let downloadedSize = try dmg.resourceValues(forKeys: [.fileSizeKey]).fileSize.map(Int64.init) ?? 0
            guard downloadedSize == asset.size,
                  try sha256(of: dmg) == digest else {
                throw AppUpdateStagerError.checksumMismatch
            }

            try fileManager.createDirectory(at: mountPoint, withIntermediateDirectories: false)
            _ = try run("/usr/bin/hdiutil", [
                "attach", "-nobrowse", "-readonly", "-noautoopen",
                "-mountpoint", mountPoint.path, dmg.path
            ])
            mounted = true

            let mountedApp = mountPoint.appendingPathComponent("CadCraft Connect.app", isDirectory: true)
            try verifyApp(mountedApp, expectedVersion: expectedVersion)
            let stagedApp = directory.appendingPathComponent("CadCraft Connect.app", isDirectory: true)
            _ = try run("/usr/bin/ditto", [mountedApp.path, stagedApp.path])
            try verifyApp(stagedApp, expectedVersion: expectedVersion)
            _ = try run("/usr/bin/hdiutil", ["detach", mountPoint.path, "-quiet"])
            mounted = false
            return StagedAppUpdate(directory: directory, app: stagedApp)
        } catch {
            if mounted {
                do {
                    _ = try run("/usr/bin/hdiutil", ["detach", mountPoint.path, "-quiet"])
                } catch {
                    NSLog("Could not detach the update disk image: %@", error.localizedDescription)
                }
            }
            do {
                try fileManager.removeItem(at: directory)
            } catch {
                NSLog("Could not remove temporary update files: %@", error.localizedDescription)
            }
            throw error
        }
    }

    static func removeStage(_ directory: URL) throws {
        try FileManager.default.removeItem(at: directory)
    }

    private static func verifyApp(_ app: URL, expectedVersion: String) throws {
        let infoURL = app.appendingPathComponent("Contents/Info.plist")
        let data = try Data(contentsOf: infoURL)
        guard let info = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              info["CFBundleIdentifier"] as? String == bundleIdentifier,
              info["CFBundleShortVersionString"] as? String == expectedVersion,
              let executable = info["CFBundleExecutable"] as? String,
              !executable.isEmpty,
              URL(fileURLWithPath: executable).lastPathComponent == executable else {
            throw AppUpdateStagerError.invalidAppBundle
        }

        let executableURL = app.appendingPathComponent("Contents/MacOS").appendingPathComponent(executable)
        guard FileManager.default.isExecutableFile(atPath: executableURL.path) else {
            throw AppUpdateStagerError.invalidAppBundle
        }
        let architectures = try run("/usr/bin/lipo", ["-archs", executableURL.path])
            .split(whereSeparator: \.isWhitespace)
        guard architectures.contains(expectedArchitecture) else {
            throw AppUpdateStagerError.wrongArchitecture
        }
        _ = try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
    }

    private static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static func run(_ executable: String, _ arguments: [String]) throws -> String {
        let process = Process()
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = outputPipe
        process.standardError = errorPipe
        try process.run()
        let outputData = outputPipe.fileHandleForReading.readDataToEndOfFile()
        let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let detail = String(decoding: errorData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw AppUpdateStagerError.commandFailed(executable, detail)
        }
        return String(decoding: outputData, as: UTF8.self)
    }

    private static func isExpectedReleaseURL(_ url: URL, releaseTag: String, assetName: String) -> Bool {
        url.scheme == "https" &&
            url.host == "github.com" &&
            url.path == "/bigmanorange123/CadCraft-MacOS-App/releases/download/\(releaseTag)/\(assetName)"
    }

    private static func isGitHubDownloadHost(_ host: String) -> Bool {
        host == "github.com" || host.hasSuffix(".githubusercontent.com")
    }

    private static var dmgAssetName: String {
        #if arch(arm64)
        "CadCraft-Connect-arm64.dmg"
        #else
        "CadCraft-Connect-x86_64.dmg"
        #endif
    }

    private static var expectedArchitecture: Substring {
        #if arch(arm64)
        "arm64"
        #else
        "x86_64"
        #endif
    }
}

private enum AppUpdateStagerError: LocalizedError {
    case invalidReleaseAsset
    case downloadFailed
    case checksumMismatch
    case invalidAppBundle
    case wrongArchitecture
    case commandFailed(String, String)

    var errorDescription: String? {
        switch self {
        case .invalidReleaseAsset:
            return "The selected update did not match a verified release asset for this Mac."
        case .downloadFailed:
            return "The update could not be downloaded from GitHub."
        case .checksumMismatch:
            return "The update failed its published size or SHA-256 verification."
        case .invalidAppBundle:
            return "The downloaded update is not the expected CadCraft Connect app."
        case .wrongArchitecture:
            return "The downloaded update does not support this Mac's processor."
        case .commandFailed(let command, let detail):
            return "\(URL(fileURLWithPath: command).lastPathComponent) failed: \(detail)"
        }
    }
}
