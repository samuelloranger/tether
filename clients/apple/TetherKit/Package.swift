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
    .target(
      name: "TetherFFIBindings",
      dependencies: ["TetherFFI"],
      path: "Sources/TetherFFIBindings"
    ),
    .target(
      name: "TetherKit",
      dependencies: ["TetherFFIBindings"],
      path: "Sources/TetherKit"
    ),
  ]
)
