// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CadCraftConnect",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "CadCraftConnect",
            path: "Sources/CadCraftConnect"
        )
    ]
)