// swift-tools-version:5.9
import Foundation
import PackageDescription

// range-source for iOS: the product RangeSource, the native reader and stores (native/src) with
// their Objective-C API (ios/Sources/RangeSource). The players find it at runtime.
//
// The target is rooted at the repo, and SwiftPM takes resource-like files anywhere under a target
// as its resources (web/, android/, node_modules), so everything but its sources is excluded.
// Listed from disk: excluding a missing path warns.
let packageDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
func entries(_ dir: String, except kept: Set<String>) -> [String] {
    let url = dir.isEmpty ? packageDir : packageDir.appendingPathComponent(dir)
    let names = (try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []
    return names
        .filter { !$0.hasPrefix(".") && !kept.contains($0) }
        .map { dir.isEmpty ? $0 : "\(dir)/\($0)" }
}
let excluded = entries("", except: ["native", "ios", "Package.swift"])
    + entries("native", except: ["include", "src"])
    + entries("ios", except: ["Sources"])

let package = Package(
    name: "range-source",
    platforms: [.iOS(.v13)],
    products: [
        .library(name: "RangeSource", targets: ["RangeSource"]),
    ],
    targets: [
        .target(
            name: "RangeSource",
            path: ".",
            exclude: excluded,
            sources: ["native/src", "ios/Sources/RangeSource"],
            publicHeadersPath: "ios/Sources/RangeSource/include",
            cxxSettings: [
                .headerSearchPath("native/include"),
                .headerSearchPath("native/src"),
            ]
        ),
        .testTarget(name: "RangeSourceTests", dependencies: ["RangeSource"], path: "ios/Tests/RangeSourceTests"),
    ],
    cxxLanguageStandard: .cxx17
)
