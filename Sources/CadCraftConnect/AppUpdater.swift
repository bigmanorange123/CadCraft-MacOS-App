import AppKit
import Combine
import Foundation

@MainActor
final class AppUpdater: ObservableObject {
    @Published private(set) var isChecking = false
    @Published private(set) var isInstalling = false
    @Published private(set) var canInstallUpdate = false
    @Published private(set) var isUpdateAvailable = false
    @Published private(set) var latestVersion: String?
    @Published private(set) var releaseURL: URL?
    @Published private(set) var message = "Updates are checked automatically once a day."

    private let currentVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
    private let lastCheckKey = "cadcraft-connect.last-update-check"
    private var updateAsset: ReleaseAsset?
    private var releaseTag: String?

    init() {
        if let error = UpdateInstaller.consumeInstallError() {
            message = "The previous update could not be installed: \(error)"
        }
    }

    func checkAutomatically() async {
        if let lastCheck = UserDefaults.standard.object(forKey: lastCheckKey) as? Date,
           Date().timeIntervalSince(lastCheck) < 86_400 {
            return
        }
        await checkNow()
    }

    func checkNow() async {
        guard !isChecking, !isInstalling else { return }
        isChecking = true
        message = "Checking for updates…"
        defer { isChecking = false }

        do {
            guard let endpoint = URL(string: "https://api.github.com/repos/bigmanorange123/CadCraft-MacOS-App/releases/latest") else {
                throw UpdateError.invalidEndpoint
            }
            var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            request.setValue("CadCraftConnect/\(currentVersion)", forHTTPHeaderField: "User-Agent")

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let response = response as? HTTPURLResponse else {
                throw UpdateError.invalidResponse
            }
            guard response.statusCode == 200 else {
                throw UpdateError.httpStatus(response.statusCode)
            }

            let release = try JSONDecoder().decode(GitHubRelease.self, from: data)
            let version = release.tagName.trimmingCharacters(in: CharacterSet(charactersIn: "vV"))
            guard let latestParts = Self.versionParts(version),
                  let currentParts = Self.versionParts(currentVersion) else {
                throw UpdateError.invalidVersion
            }

            latestVersion = version
            releaseTag = release.tagName
            releaseURL = release.htmlURL
            isUpdateAvailable = Self.isNewer(latestParts, than: currentParts)
            let asset = release.assets.first(where: { $0.name == Self.dmgAssetName })
            updateAsset = isUpdateAvailable && asset?.isVerifiable == true ? asset : nil
            canInstallUpdate = updateAsset != nil

            if isUpdateAvailable {
                message = canInstallUpdate
                    ? "CadCraft Connect \(version) is available. Install it here and the app will restart."
                    : "CadCraft Connect \(version) is available, but its installer could not be verified."
            } else {
                message = "CadCraft Connect is up to date (v\(currentVersion))."
            }
            UserDefaults.standard.set(Date(), forKey: lastCheckKey)
        } catch {
            updateAsset = nil
            canInstallUpdate = false
            message = "Could not check for updates: \(error.localizedDescription)"
        }
    }

    func installUpdate() async {
        guard !isInstalling, let asset = updateAsset,
              let version = latestVersion, let tag = releaseTag else {
            return
        }
        isInstalling = true
        message = "Downloading and verifying CadCraft Connect \(version)…"
        defer { isInstalling = false }

        do {
            let staged = try await Task.detached(priority: .userInitiated) {
                try await AppUpdateStager.prepare(
                    asset: asset,
                    expectedVersion: version,
                    releaseTag: tag
                )
            }.value
            do {
                try UpdateInstaller.launchHelper(
                    stagedApp: staged.app,
                    temporaryDirectory: staged.directory,
                    expectedVersion: version
                )
            } catch {
                try AppUpdateStager.removeStage(staged.directory)
                throw error
            }
            message = "Installing v\(version). CadCraft Connect will restart shortly."
            NSApp.terminate(nil)
        } catch {
            message = "Could not install the update: \(error.localizedDescription)"
        }
    }

    private static var dmgAssetName: String {
        #if arch(arm64)
        "CadCraft-Connect-arm64.dmg"
        #else
        "CadCraft-Connect-x86_64.dmg"
        #endif
    }

    private static func versionParts(_ version: String) -> [Int]? {
        let parts = version.split(separator: ".", omittingEmptySubsequences: false)
        guard !parts.isEmpty else { return nil }
        let numbers = parts.compactMap { Int($0) }
        return numbers.count == parts.count ? numbers : nil
    }

    private static func isNewer(_ candidate: [Int], than current: [Int]) -> Bool {
        for index in 0..<max(candidate.count, current.count) {
            let newPart = index < candidate.count ? candidate[index] : 0
            let currentPart = index < current.count ? current[index] : 0
            if newPart != currentPart { return newPart > currentPart }
        }
        return false
    }
}

struct ReleaseAsset: Decodable, Sendable {
    let name: String
    let downloadURL: URL
    let size: Int64
    let digest: String?

    var isVerifiable: Bool {
        size > 0 && digest?.range(of: #"^sha256:[a-fA-F0-9]{64}$"#, options: .regularExpression) != nil
    }

    enum CodingKeys: String, CodingKey {
        case name
        case downloadURL = "browser_download_url"
        case size
        case digest
    }
}

private struct GitHubRelease: Decodable {
    let tagName: String
    let htmlURL: URL
    let assets: [ReleaseAsset]

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case htmlURL = "html_url"
        case assets
    }
}

private enum UpdateError: LocalizedError {
    case invalidEndpoint
    case invalidResponse
    case httpStatus(Int)
    case invalidVersion

    var errorDescription: String? {
        switch self {
        case .invalidEndpoint:
            return "The update service URL is invalid."
        case .invalidResponse:
            return "The update service returned an invalid response."
        case .httpStatus(let code):
            return "GitHub returned HTTP \(code)."
        case .invalidVersion:
            return "The latest release has an invalid version number."
        }
    }
}
