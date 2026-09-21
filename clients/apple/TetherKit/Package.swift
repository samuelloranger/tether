// swift-tools-version: 5.10
import PackageDescription

let package = Package(
  name: "TetherKit",
  platforms: [
    .iOS(.v17),
    .macOS(.v14),
  ],
  products: [
    .library(name: "TetherKit", targets: ["TetherKit"]),
  ],
  targets: [
    .binaryTarget(
      name: "TetherFFI",
      path: "Frameworks/TetherFFI.xcframework"
    ),
    .binaryTarget(
      name: "LibSSH2",
      path: "Frameworks/SSH/ssh2.xcframework"
    ),
    .binaryTarget(
      name: "OpenSSLCrypto",
      path: "Frameworks/SSH/crypto.xcframework"
    ),
    .binaryTarget(
      name: "OpenSSLSSL",
      path: "Frameworks/SSH/ssl.xcframework"
    ),
    .target(
      name: "CLibSSH2",
      dependencies: ["LibSSH2", "OpenSSLCrypto", "OpenSSLSSL"],
      path: "Sources/CLibSSH2",
      publicHeadersPath: "include",
      linkerSettings: [.linkedLibrary("z")]
    ),
    .target(
      name: "TetherFFIBindings",
      dependencies: ["TetherFFI"],
      path: "Sources/TetherFFIBindings"
    ),
    .target(
      name: "TetherKit",
      dependencies: ["TetherFFIBindings", "CLibSSH2"],
      path: "Sources/TetherKit"
    ),
    .testTarget(
      name: "TetherKitTests",
      dependencies: ["TetherKit", "TetherFFIBindings"],
      path: "Tests/TetherKitTests"
    ),
  ]
)
