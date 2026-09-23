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
  dependencies: [
    // 2.0 API on main; switch to from: "2.0.0" once tagged.
    .package(
      url: "https://github.com/migueldeicaza/SwiftTerm.git",
      revision: "082119f6fe9207eca15ed7083460792eb2883d7d"
    ),
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
      dependencies: [
        "TetherFFIBindings", "CLibSSH2",
        .product(name: "SwiftTerm", package: "SwiftTerm"),
      ],
      path: "Sources/TetherKit"
    ),
    .testTarget(
      name: "TetherKitTests",
      dependencies: [
        "TetherKit", "TetherFFIBindings",
        .product(name: "SwiftTerm", package: "SwiftTerm"),
      ],
      path: "Tests/TetherKitTests"
    ),
  ]
)
