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

  func test_a_header_git_adds_later_is_skipped_because_it_is_classified_not_matched() {
    // `mode 100644` is a real git header the prefix list never knew about.
    let lines = GitDiffModel.classify("""
    diff --git a/x b/x
    old mode 100644
    new mode 100755
    @@ -1 +1 @@
    -a
    +b
    """)
    let files = DiffFile.group(lines)
    XCTAssertEqual(files.count, 1)
    XCTAssertEqual(files[0].rows.filter { $0.kind == .removed }.map(\.text), ["a"])
    XCTAssertFalse(files[0].rows.contains { $0.text == "old mode 100644" })
  }

  func test_totals_come_from_one_place() {
    let lines = GitDiffModel.classify("diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n+c")
    let files = DiffFile.group(lines)
    XCTAssertEqual(DiffFile.stat(files).added, 2)
    XCTAssertEqual(DiffFile.stat(files).removed, 1)
  }

  func test_a_removed_sql_comment_is_a_removal_not_a_file_header() {
    let files = DiffFile.group(GitDiffModel.classify("diff --git a/q.sql b/q.sql\n@@ -1,2 +1,2 @@\n--- old comment\n+++ new increment\n kept"))
    XCTAssertEqual(files.count, 1)
    XCTAssertEqual(files[0].rows.filter { $0.kind == .removed }.map(\.text), ["-- old comment"])
    XCTAssertEqual(files[0].rows.filter { $0.kind == .added }.map(\.text), ["++ new increment"])
    XCTAssertEqual(files[0].rows.last?.oldLine, 2)
    XCTAssertEqual(files[0].rows.last?.newLine, 2)
  }

  func test_a_binary_file_says_so_instead_of_rendering_a_numbered_line() {
    let files = DiffFile.group(GitDiffModel.classify(
      "diff --git a/img.png b/img.png\nindex 1..2 100644\nBinary files a/img.png and b/img.png differ"))
    XCTAssertEqual(files.map(\.path), ["img.png"])
    XCTAssertEqual(files[0].rows.map(\.kind), [.plain])
    XCTAssertEqual(files[0].rows[0].text, "Binary files a/img.png and b/img.png differ")
  }

  func test_no_newline_at_end_of_file_does_not_shift_the_numbers() {
    let rows = DiffFile.group(GitDiffModel.classify(
      "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file"))[0].rows
    XCTAssertEqual(rows.first { $0.kind == .added }?.newLine, 1)
    XCTAssertEqual(rows.filter { $0.kind == .plain }.count, 2)
  }

  func test_a_trailing_newline_adds_no_blank_row() {
    let rows = DiffFile.group(GitDiffModel.classify("diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n"))[0].rows
    XCTAssertEqual(rows.map(\.kind), [.hunk, .removed, .added])
  }

  func test_a_quoted_path_is_unquoted() {
    let files = DiffFile.group(GitDiffModel.classify(
      "diff --git \"a/caf\\303\\251.txt\" \"b/caf\\303\\251.txt\"\n--- \"a/caf\\303\\251.txt\"\n+++ \"b/caf\\303\\251.txt\"\n@@ -1 +1 @@\n-a\n+b"))
    XCTAssertEqual(files.map(\.path), ["café.txt"])
  }

  func test_a_path_with_a_space_is_read_whole() {
    let files = DiffFile.group(GitDiffModel.classify(
      "diff --git a/my b/file.txt b/my b/file.txt\n--- a/my b/file.txt\t\n+++ b/my b/file.txt\t\n@@ -1 +1 @@\n-a\n+b"))
    XCTAssertEqual(files.map(\.path), ["my b/file.txt"])
    XCTAssertEqual(DiffFile.gitHeaderPath("diff --git a/my b/file.txt b/my b/file.txt"), "my b/file.txt")
  }

  func test_a_pure_rename_or_mode_change_is_shown_not_dropped() {
    let files = DiffFile.group(GitDiffModel.classify("""
    diff --git a/old.txt b/new.txt
    similarity index 100%
    rename from old.txt
    rename to new.txt
    diff --git a/run.sh b/run.sh
    old mode 100644
    new mode 100755
    """))
    XCTAssertEqual(files.map(\.path), ["new.txt", "run.sh"])
    XCTAssertEqual(files[0].rows.map(\.text), ["Renamed from old.txt"])
    XCTAssertEqual(files[1].rows.map(\.text), ["Mode 100644 → 100755"])
  }

  func test_a_deleted_file_is_named_by_its_old_path() {
    let files = DiffFile.group(GitDiffModel.classify(
      "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-a"))
    XCTAssertEqual(files.map(\.path), ["gone.txt"])
    XCTAssertEqual(files[0].removed, 1)
  }

  func test_a_combined_merge_diff_strips_one_marker_per_parent() {
    let lines = GitDiffModel.classify("diff --cc f\n@@@ -1,2 -1,2 +1,2 @@@\n- a\n -b\n++c\n  d")
    XCTAssertEqual(lines.map(\.kind), [.fileHeader, .hunk, .removed, .removed, .added, .context])
    let rows = DiffFile.group(lines)[0].rows
    XCTAssertEqual(rows.dropFirst().map(\.text), ["a", "b", "c", "d"])
  }

  func test_row_ids_restart_per_file() {
    let files = DiffFile.group(GitDiffModel.classify(patch))
    XCTAssertEqual(files[1].rows.first?.id, 0)
  }

  func test_a_hunk_copies_as_a_patch() {
    let file = DiffFile.group(GitDiffModel.classify(patch))[1]
    XCTAssertEqual(file.hunkPatch(startingAt: 0), "@@ -1,2 +1,1 @@\n-old\n kept\n")
    XCTAssertTrue(file.patchText.hasPrefix("--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,1 @@\n"))
  }

  func test_the_gutter_is_as_wide_as_the_largest_line_number() {
    let file = DiffFile.group(GitDiffModel.classify("diff --git a/x b/x\n@@ -99998,2 +99998,2 @@\n a\n-b\n+c"))[0]
    XCTAssertEqual(file.lineDigits, 5)
  }
}

