import XCTest
@testable import TetherKit

final class ACPDiffAdapterTests: XCTestCase {
  func test_a_new_file_is_all_additions_numbered_from_one() {
    let file = ACPDiffAdapter.file(
      for: ACPDiff(path: "/w/p/out.txt", oldText: nil, newText: "a\nb\n"), relativeTo: "/w/p")
    XCTAssertEqual(file.path, "out.txt")
    XCTAssertEqual(file.added, 2)
    XCTAssertEqual(file.removed, 0)
    XCTAssertEqual(file.rows.map(\.kind), [.added, .added])
    XCTAssertEqual(file.rows.map(\.newLine), [1, 2])
    XCTAssertEqual(file.rows.map(\.id), [0, 1])
  }

  func test_an_edit_keeps_three_lines_of_context_and_marks_the_gap() {
    let old = (1...20).map { "line \($0)" }
    var new = old
    new[9] = "changed"
    let file = ACPDiffAdapter.file(
      for: ACPDiff(path: "f.txt", oldText: old.joined(separator: "\n"), newText: new.joined(separator: "\n")),
      relativeTo: "/w")
    XCTAssertEqual(file.added, 1)
    XCTAssertEqual(file.removed, 1)
    XCTAssertEqual(file.rows.first?.kind, .hunk)
    XCTAssertEqual(file.rows.filter { $0.kind == .context }.count, 6)
    let removed = file.rows.first { $0.kind == .removed }
    let added = file.rows.first { $0.kind == .added }
    XCTAssertEqual(removed?.text, "line 10")
    XCTAssertEqual(removed?.oldLine, 10)
    XCTAssertEqual(added?.text, "changed")
    XCTAssertEqual(added?.newLine, 10)
    XCTAssertEqual(file.rows.map(\.id), Array(file.rows.indices))
  }

  func test_identical_text_says_so_instead_of_drawing_nothing() {
    let file = ACPDiffAdapter.file(for: ACPDiff(path: "f", oldText: "x\n", newText: "x\n"), relativeTo: "/w")
    XCTAssertEqual(file.rows.map(\.text), ["No changes"])
    XCTAssertEqual(file.added + file.removed, 0)
  }

  func test_inserted_lines_in_the_middle_do_not_mark_the_rest_as_changed() {
    let file = ACPDiffAdapter.file(
      for: ACPDiff(path: "f", oldText: "a\nb\nc\n", newText: "a\nb\nNEW\nc\n"), relativeTo: "/w")
    XCTAssertEqual(file.added, 1)
    XCTAssertEqual(file.removed, 0)
    XCTAssertEqual(file.rows.map(\.kind), [.context, .context, .added, .context])
  }
}
