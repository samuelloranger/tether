import SwiftUI
import XCTest
@testable import TetherKit

/// At accessibility text sizes a session row keeps what identifies the session —
/// its name and its state — and drops the two details that would push those off
/// screen. Nothing caps Dynamic Type to keep the row dense.
final class DynamicTypeLayoutTests: XCTestCase {
  func test_ordinary_text_sizes_keep_the_working_directory_and_client_count() {
    XCTAssertTrue(DynamicTypeLayout.showsDetail(for: .large))
    XCTAssertTrue(DynamicTypeLayout.showsDetail(for: .xxxLarge))
  }

  func test_accessibility_text_sizes_drop_the_details() {
    XCTAssertFalse(DynamicTypeLayout.showsDetail(for: .accessibility1))
    XCTAssertFalse(DynamicTypeLayout.showsDetail(for: .accessibility5))
  }

  func test_the_row_stacks_vertically_only_at_accessibility_sizes() {
    XCTAssertFalse(DynamicTypeLayout.stacksVertically(for: .xxxLarge))
    XCTAssertTrue(DynamicTypeLayout.stacksVertically(for: .accessibility2))
  }
}
