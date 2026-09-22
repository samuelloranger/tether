import XCTest
@testable import TetherKit

/// Raw patch text becomes per-file groups with real line numbers, so the screen
/// can show code rather than git's output.
final class DiffFileTests: XCTestCase {
  private let patch = """
  diff --git a/Sources/App.swift b/Sources/App.swift
  index 8de5128..bae5af6 100644
  --- a/Sources/App.swift
  +++ b/Sources/App.swift
  @@ -12,6 +12,7 @@ struct App {
     let a = 1
  -  let b = 2
  +  let b = 3
  +  let c = 4
     let d = 5
  diff --git a/README.md b/README.md
  --- a/README.md
  +++ b/README.md
  @@ -1,2 +1,1 @@
  -old
   kept
  """

  func test_splits_the_patch_into_files_named_by_their_new_path() {
    let files = DiffFile.group(GitDiffModel.classify(patch))
    XCTAssertEqual(files.map(\.path), ["Sources/App.swift", "README.md"])
  }

  func test_counts_additions_and_removals_per_file() {
    let files = DiffFile.group(GitDiffModel.classify(patch))
    XCTAssertEqual(files[0].added, 2)
    XCTAssertEqual(files[0].removed, 1)
    XCTAssertEqual(files[1].added, 0)
    XCTAssertEqual(files[1].removed, 1)
  }

  func test_numbers_lines_from_the_hunk_header() {
    let rows = DiffFile.group(GitDiffModel.classify(patch))[0].rows
    let code = rows.filter { $0.kind != .hunk }

    XCTAssertEqual(code.map(\.oldLine), [12, 13, nil, nil, 14])
    XCTAssertEqual(code.map(\.newLine), [12, nil, 13, 14, 15])
  }

  func test_strips_the_marker_so_the_gutter_can_carry_it() {
    let rows = DiffFile.group(GitDiffModel.classify(patch))[0].rows
    XCTAssertEqual(rows.first(where: { $0.kind == .added })?.text, "  let b = 3")
    XCTAssertEqual(rows.first(where: { $0.kind == .removed })?.text, "  let b = 2")
  }

  func test_a_hunk_keeps_only_its_context_not_the_line_arithmetic() {
    let hunk = DiffFile.group(GitDiffModel.classify(patch))[0].rows.first { $0.kind == .hunk }
    XCTAssertEqual(hunk?.text, "struct App {")
  }

  func test_index_and_path_headers_are_not_rows() {
    let rows = DiffFile.group(GitDiffModel.classify(patch))[0].rows
    XCTAssertFalse(rows.contains { $0.text.hasPrefix("index ") })
    XCTAssertFalse(rows.contains { $0.text.hasPrefix("+++ ") })
    XCTAssertFalse(rows.contains { $0.text.hasPrefix("--- ") })
  }

  /// `git show` prints a message and a stat block before the first file.
  func test_anything_before_the_first_file_is_kept_as_a_preamble() {
    let output = """
    Fix the thing

     Sources/App.swift | 2 +-
     1 file changed

    diff --git a/Sources/App.swift b/Sources/App.swift
    @@ -1,1 +1,1 @@
    -a
    +b
    """
    let files = DiffFile.group(GitDiffModel.classify(output))
    XCTAssertEqual(files.count, 2)
    XCTAssertTrue(files[0].isPreamble)
    XCTAssertTrue(files[0].rows.contains { $0.text.contains("Fix the thing") })
    XCTAssertEqual(files[1].path, "Sources/App.swift")
  }

  func test_empty_input_has_no_files() {
    XCTAssertEqual(DiffFile.group([]).count, 0)
  }
}
