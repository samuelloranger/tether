import Foundation
import XCTest
@testable import TetherKit

final class GitDiffModelTests: XCTestCase {
  func test_classifies_each_line_of_a_unified_diff() {
    let diff = """
    diff --git a/foo.txt b/foo.txt
    index 1234567..89abcde 100644
    --- a/foo.txt
    +++ b/foo.txt
    @@ -1,3 +1,3 @@ context header
     unchanged line
    -removed line
    +added line
    """
    let lines = GitDiffModel.classify(diff)
    XCTAssertEqual(lines.map(\.kind), [
      .fileHeader, .fileHeader, .fileHeader, .fileHeader, .hunk, .context, .removed, .added,
    ])
    XCTAssertEqual(lines[6].text, "-removed line")
  }

  func test_plus_minus_file_headers_are_not_added_or_removed() {
    let lines = GitDiffModel.classify("--- a/x\n+++ b/x")
    XCTAssertEqual(lines.map(\.kind), [.fileHeader, .fileHeader])
  }

  func test_empty_diff_is_no_lines() {
    XCTAssertTrue(GitDiffModel.classify("").isEmpty)
  }

  func test_counts_added_and_removed() {
    let stat = GitDiffModel.stat(GitDiffModel.classify("@@ -0,0 +1,2 @@\n+a\n+b\n-c"))
    XCTAssertEqual(stat.added, 2)
    XCTAssertEqual(stat.removed, 1)
  }
}
