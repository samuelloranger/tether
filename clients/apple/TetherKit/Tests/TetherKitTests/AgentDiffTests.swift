import XCTest

@testable import TetherKit

final class AgentDiffTests: XCTestCase {
  func testIdenticalYieldsEmpty() {
    XCTAssertEqual(unifiedLineDiff(old: "same", new: "same"), "")
  }

  func testSingleLineReplacement() {
    let diff = unifiedLineDiff(old: "old", new: "new")
    XCTAssertEqual(diff, "@@ -1,1 +1,1 @@\n-old\n+new")
  }

  func testKeepsUnchangedLinesAsContext() {
    let old = "a\nb\nc"
    let new = "a\nB\nc"
    let diff = unifiedLineDiff(old: old, new: new)
    XCTAssertTrue(diff.contains(" a"), diff)
    XCTAssertTrue(diff.contains("-b"), diff)
    XCTAssertTrue(diff.contains("+B"), diff)
    XCTAssertTrue(diff.contains(" c"), diff)
  }

  func testWriteFromEmptyIsAllAdditions() {
    let diff = unifiedLineDiff(old: "", new: "one\ntwo")
    XCTAssertEqual(diff, "@@ -0,0 +1,2 @@\n+one\n+two")
  }

  /// Empty-old is a fast path that bypasses `lcsDiffOps` entirely (see
  /// `unifiedLineDiff`) — assert on the shape (all `+`, one per new line)
  /// rather than reimplementing LCS math here.
  func testEmptyOldFastPathIsAllAdditionsWithoutLCS() {
    let diff = unifiedLineDiff(old: "", new: "alpha\nbeta\ngamma")
    let lines = diff.split(separator: "\n").map(String.init)
    XCTAssertEqual(lines.first, "@@ -0,0 +1,3 @@")
    XCTAssertEqual(Array(lines.dropFirst()), ["+alpha", "+beta", "+gamma"])
  }

  func testEmptyNewFastPathIsAllRemovals() {
    let diff = unifiedLineDiff(old: "alpha\nbeta", new: "")
    XCTAssertEqual(diff, "@@ -1,2 +0,0 @@\n-alpha\n-beta")
  }

  func testPureInsertionKeepsContext() {
    let diff = unifiedLineDiff(old: "a\nc", new: "a\nb\nc")
    XCTAssertEqual(diff, "@@ -1,2 +1,3 @@\n a\n+b\n c")
  }
}
