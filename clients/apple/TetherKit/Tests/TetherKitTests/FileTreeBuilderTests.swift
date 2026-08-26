import XCTest
@testable import TetherKit

final class FileTreeBuilderTests: XCTestCase {
  func test_build_file_tree_nests_path_segments_into_directories() {
    let files = [
      DiffFileStat(path: "src/a/b.ts", insertions: 1, deletions: 0, binary: false),
      DiffFileStat(path: "src/a/c.ts", insertions: 0, deletions: 1, binary: false),
      DiffFileStat(path: "README.md", insertions: 2, deletions: 0, binary: false),
    ]
    let tree = buildFileTree(files: files)
    XCTAssertEqual(tree.count, 2)

    // Insertion order is preserved at each level — src was seen before README.
    guard case let .dir(srcName, srcPath, srcChildren) = tree[0] else {
      return XCTFail("expected a src directory first")
    }
    XCTAssertEqual(srcName, "src")
    XCTAssertEqual(srcPath, "src")
    XCTAssertEqual(srcChildren.count, 1)

    guard case let .dir(aName, aPath, aChildren) = srcChildren[0] else {
      return XCTFail("expected src/a")
    }
    XCTAssertEqual(aName, "a")
    XCTAssertEqual(aPath, "src/a")
    XCTAssertEqual(aChildren.count, 2)
    XCTAssertEqual(aChildren.map(\.name), ["b.ts", "c.ts"])

    guard case let .file(readmeName, readmePath, _) = tree[1] else {
      return XCTFail("expected a root file second")
    }
    XCTAssertEqual(readmeName, "README.md")
    XCTAssertEqual(readmePath, "README.md")
  }

  func test_build_file_tree_keeps_root_files_beside_directories() {
    let files = [
      DiffFileStat(path: "alone.txt", insertions: 0, deletions: 0, binary: false),
    ]
    let tree = buildFileTree(files: files)
    XCTAssertEqual(tree.count, 1)
    guard case let .file(name, path, file) = tree[0] else {
      return XCTFail("expected a single root file")
    }
    XCTAssertEqual(name, "alone.txt")
    XCTAssertEqual(path, "alone.txt")
    XCTAssertEqual(file.path, "alone.txt")
  }

  func test_build_file_tree_skips_entries_whose_path_has_no_segments() {
    let files = [
      DiffFileStat(path: "", insertions: 0, deletions: 0, binary: false),
    ]
    XCTAssertTrue(buildFileTree(files: files).isEmpty)
  }
}

final class WorkspaceHelperTests: XCTestCase {
  func test_workspace_line_offset_clamps_one_based_line_into_content_bounds() {
    let content = "a\nb\nc"
    XCTAssertEqual(workspaceLineOffset(content: content, line: nil), 0)
    XCTAssertEqual(workspaceLineOffset(content: content, line: 1), 0)
    XCTAssertEqual(workspaceLineOffset(content: content, line: 3), 2)
    XCTAssertEqual(workspaceLineOffset(content: content, line: 99), 2)
    XCTAssertEqual(workspaceLineOffset(content: content, line: 0), 0)
  }

  func test_shell_quote_wraps_in_single_quotes_and_escapes_embedded_quotes() {
    XCTAssertEqual(shellQuote("plain"), "'plain'")
    XCTAssertEqual(shellQuote("a'b"), "'a'\"'\"'b'")
  }

  func test_pick_auto_select_preview_picks_the_first_unseen_row_for_the_active_session() {
    let rows = [
      Presentation(
        id: "old",
        title: "Old",
        project: "p",
        revision: 1,
        url: "/x",
        sessionId: "s1"
      ),
      Presentation(
        id: "new",
        title: "New",
        project: "p",
        revision: 1,
        url: "/y",
        sessionId: "s1"
      ),
      Presentation(
        id: "other",
        title: "Other",
        project: "p",
        revision: 1,
        url: "/z",
        sessionId: "s2"
      ),
    ]
    let picked = pickAutoSelectPreview(rows: rows, seen: ["old"], activeId: "s1")
    XCTAssertEqual(picked?.id, "new")
    XCTAssertNil(pickAutoSelectPreview(rows: rows, seen: ["old", "new"], activeId: "s1"))
  }
}
