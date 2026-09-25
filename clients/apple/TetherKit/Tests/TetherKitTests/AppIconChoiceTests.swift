import XCTest
@testable import TetherKit

final class AppIconChoiceTests: XCTestCase {
  /// clients/apple, found from this file so the check reads the checkout under test.
  private let appleDir = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent()

  func testEveryIconHasAPreviewInTheBundle() {
    for choice in AppIconChoice.all {
      XCTAssertNotNil(choice.previewURL, "\(choice.id) has no preview")
    }
  }

  func testIdsAreUniqueAndOnlyThePrimaryHasNoAssetName() {
    XCTAssertEqual(Set(AppIconChoice.all.map(\.id)).count, AppIconChoice.all.count)
    XCTAssertEqual(AppIconChoice.all.filter { $0.assetName == nil }, [AppIconChoice.primary])
  }

  func testCurrentFallsBackToThePrimaryIcon() {
    XCTAssertEqual(AppIconChoice.current(alternateName: nil), .primary)
    XCTAssertEqual(AppIconChoice.current(alternateName: "AppIcon-nord").id, "nord")
    XCTAssertEqual(AppIconChoice.current(alternateName: "AppIcon-gone"), .primary)
  }

  /// iOS only switches to icons the app target declares; one missing from the build
  /// setting fails at runtime with nothing but an error alert.
  func testTheAppTargetDeclaresEveryAlternateIcon() throws {
    let projectFile = appleDir.appendingPathComponent("Tether.xcodeproj/project.pbxproj")
    guard FileManager.default.fileExists(atPath: projectFile.path) else {
      throw XCTSkip("the checkout isn't reachable from this test run")
    }
    let project = try String(contentsOf: projectFile, encoding: .utf8)
    let expected = Set(AppIconChoice.all.compactMap(\.assetName))
    let declared = project.components(separatedBy: "\n")
      .filter { $0.contains("ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES") }
      .map { line in
        Set(line.split(separator: "\"").dropFirst().first.map { $0.split(separator: " ").map(String.init) } ?? [])
      }
    XCTAssertEqual(declared.count, 2, "Debug and Release")
    for names in declared { XCTAssertEqual(names, expected) }
    for name in expected {
      let icon = appleDir.appendingPathComponent("TetherIOS/Assets.xcassets/\(name).appiconset/icon-1024.png")
      XCTAssertTrue(FileManager.default.fileExists(atPath: icon.path), "\(name) has no icon")
    }
  }
}
