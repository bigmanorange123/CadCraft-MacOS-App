import Combine
import Foundation

@MainActor
final class AppUpdater: ObservableObject {
    @Published private(set) var isChecking = false
    @Published private(set) var isUpdateAvailable = false
    @Published private(set) var latestVersion: String?
    @Published private(set) var downloadURL: URL?
    @Published private(set) var releaseURL: URL?
    @Published private(set) var message = "Updates are checked automatically once a day."

    private let currentVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
    private let lastCheckKey = "cadcraft-connect.last-update-check"

    func checkAutomatically() async {
        if let lastCheck = UserDefaults.standard.object(forKey: lastCheckKey) as? Date,
           Date().timeIntervalSince(lastCheck) < 86_400 {
            return
        }
        await checkNow()
    }

    func checkNow() async {
        guard !isChecking else { return }
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
            releaseURL = release.htmlURL
            isUpdateAvailable = Self.isNewer(latestParts, than: currentParts)
            downloadURL = isUpdateAvailable
                ? release.assets.first(where: { $0.name == Self.dmgAssetName })?.downloadURL
                : nil
            if isUpdateAvailable {
                message = downloadURL == nil
                    ? "CadCraft Connect \(version) is available. Open the release page to download it."
                    : "CadCraft Connect \(version) is available for this Mac."
            } else {
                message = "CadCraft Connect is up to date (v\(currentVersion))."
            }
            UserDefaults.standard.set(Date(), forKey: lastCheckKey)
        } catch {
            message = "Could not check for updates: \(error.localizedDescription)"
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

private struct ReleaseAsset: Decodable {
    let name: String
    let downloadURL: URL

    enum CodingKeys: String, CodingKey {
        case name
        case downloadURL = "browser_download_url"
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
