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

  func test_a_commit_show_is_split_into_its_message_and_its_patch() {
    // `git show --format=%b%x1e` marks the end of the body, so the patch the
    // diff pipeline receives never contains commit prose.
    let output = """
    Rework the thing.

    A second paragraph.
    \u{1E}diff --git a/foo.txt b/foo.txt
    --- a/foo.txt
    +++ b/foo.txt
    @@ -1 +1 @@
    -old
    +new
    """
    let shown = GitDiffModel.commitShow(output)
    XCTAssertEqual(shown.body, "Rework the thing.\n\nA second paragraph.")
    XCTAssertTrue(shown.patch.hasPrefix("diff --git "))
    XCTAssertFalse(shown.patch.contains("Rework the thing."))
  }

  func test_a_commit_with_no_message_body_yields_no_stray_lines() {
    // The release commit's shape: an empty body, then the marker, then the patch.
    let shown = GitDiffModel.commitShow("\u{1E}diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b")
    XCTAssertEqual(shown.body, "")
    XCTAssertEqual(GitDiffModel.classify(shown.patch).map(\.kind), [
      .fileHeader, .hunk, .removed, .added,
    ])
  }

  func test_the_separator_git_prints_before_a_diffstat_is_never_a_removed_line() {
    // Regression: `---` fell through to the `-` rule, rendering as a deletion
    // numbered 0 and inflating every commit's removed count by one.
    let shown = GitDiffModel.commitShow("\u{1E}diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b")
    let stat = GitDiffModel.stat(GitDiffModel.classify(shown.patch))
    XCTAssertEqual(stat.removed, 1)
    XCTAssertEqual(stat.added, 1)
  }

  func test_output_without_the_marker_is_all_patch() {
    // `gh pr diff` emits a bare patch with no commit message in front of it.
    let shown = GitDiffModel.commitShow("diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b")
    XCTAssertEqual(shown.body, "")
    XCTAssertTrue(shown.patch.hasPrefix("diff --git "))
  }
}
