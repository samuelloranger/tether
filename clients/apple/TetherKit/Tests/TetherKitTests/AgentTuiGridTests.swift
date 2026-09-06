import Foundation
import XCTest

import TetherFFIBindings
@testable import TetherKit

/// The grid the iOS surface actually shows, driven the way Claude Code / Codex /
/// Cursor Agent paint: alternate screen, CUP, a full-height redraw.
///
/// Session switch throws this emulator away and rebuilds from byte replay. These
/// pin why that comes up blank, garbled, or with a gap at the bottom that pan
/// cannot close until the agent writes again.
final class AgentTuiGridTests: XCTestCase {
  private let cols: UInt16 = 20
  private let rows: UInt16 = 8
  private let grownRows: UInt16 = 12

  /// Hand-checked 20-column rows. R1/R8 are two characters; R12 is three.
  private let row1 = "R1xxxxxxxxxxxxxxxxxx"
  private let row8 = "R8xxxxxxxxxxxxxxxxxx"
  private let row12 = "R12xxxxxxxxxxxxxxxxx"

  func testFullPaintFillsEveryRowIncludingTheLast() throws {
    let emulator = FfiTerminalEmulator(cols: cols, rows: rows)
    emulator.feed(bytes: altScreenBytes(cols: cols, rows: rows))
    let snapshot = try decode(emulator)
    XCTAssertEqual(rowText(snapshot, 0), row1)
    XCTAssertEqual(rowText(snapshot, 7), row8)
  }

  /// Switching A → B → A rebuilds an empty emulator. Replay at the size the TUI
  /// painted must restore the last row, or the surface is blank until new output.
  func testReplayAtTheSameSizeRestoresTheLastRow() throws {
    let replayed = FfiTerminalEmulator(cols: cols, rows: rows)
    replayed.feed(bytes: altScreenBytes(cols: cols, rows: rows))
        XCTAssertEqual(rowText(try decode(replayed), 7), row8)
  }

  func testAltScreenPaintSetsTheSnapshotFlag() throws {
    let emulator = FfiTerminalEmulator(cols: cols, rows: rows)
    emulator.feed(bytes: altScreenBytes(cols: cols, rows: rows))
    XCTAssertTrue(try decode(emulator).header.altScreen)
  }

  /// A brand-new emulator (what `connectNoise` installs before replay lands) has
  /// nothing to pan into — the "blank until the agent writes" screen.
  func testAFreshEmulatorHasNoContentToScrollInto() throws {
    let emulator = FfiTerminalEmulator(cols: cols, rows: rows)
    XCTAssertEqual(rowText(try decode(emulator), 7), "")
    emulator.scrollViewport(lines: 40)
    XCTAssertEqual(rowText(try decode(emulator), 7), "")
  }

  /// The "big gap at the bottom / terminal pushed" look: the TUI painted the old
  /// height, then the local grid grew. Empty rows land under the content.
  func testResizeUpOnAltScreenLeavesTrailingEmptyRows() throws {
    let emulator = FfiTerminalEmulator(cols: cols, rows: rows)
    emulator.feed(bytes: altScreenBytes(cols: cols, rows: rows))
    emulator.resize(cols: cols, rows: grownRows)
    let snapshot = try decode(emulator)
    XCTAssertEqual(snapshot.header.rows, grownRows)
    XCTAssertEqual(rowText(snapshot, 0), row1)
    XCTAssertEqual(rowText(snapshot, 7), row8)
    XCTAssertEqual(rowText(snapshot, 8), "")
    XCTAssertEqual(rowText(snapshot, 11), "")
  }

  /// Why pan does nothing until the agent writes: alt-screen has no scrollback.
  func testScrollDoesNotMoveAltScreenContentIntoTheGap() throws {
    let emulator = FfiTerminalEmulator(cols: cols, rows: rows)
    emulator.feed(bytes: altScreenBytes(cols: cols, rows: rows))
    emulator.resize(cols: cols, rows: grownRows)
    let before = rowText(try decode(emulator), 0)
    emulator.scrollViewport(lines: 40)
    emulator.scrollViewport(lines: -40)
    let after = try decode(emulator)
    XCTAssertEqual(rowText(after, 0), before)
    XCTAssertEqual(rowText(after, 11), "")
  }

  func testARepaintAtTheNewSizeFillsTheGap() throws {
    let emulator = FfiTerminalEmulator(cols: cols, rows: rows)
    emulator.feed(bytes: altScreenBytes(cols: cols, rows: rows))
    emulator.resize(cols: cols, rows: grownRows)
    emulator.feed(bytes: altScreenBytes(cols: cols, rows: grownRows))
    let snapshot = try decode(emulator)
    XCTAssertEqual(rowText(snapshot, 0), row1)
    XCTAssertEqual(rowText(snapshot, 11), row12)
  }

  /// Replay of a taller TUI into a shorter emulator (start used 80×24, layout
  /// then grew). CUP past the bottom overwrites the last row, then growing
  /// leaves empty rows underneath — garbled TUI plus the unscrolled gap.
  ///
  /// `resize()` cannot recover those rows. Rebuild-from-buffer at the grown
  /// size is the path that does (see `testRebuildFromBufferAtGrownSizeRestoresEveryRow`).
  func testReplayIntoAShorterGridThenGrowLeavesGarbleAndAGap() throws {
    let replayed = FfiTerminalEmulator(cols: cols, rows: rows)
    replayed.feed(bytes: altScreenBytes(cols: cols, rows: grownRows))
    let short = try decode(replayed)
    XCTAssertEqual(rowText(short, 0), row1)
    XCTAssertEqual(
      rowText(short, 7),
      row12,
      "CUP past the last row overwrites it — the middle of the TUI is gone"
    )
    replayed.resize(cols: cols, rows: grownRows)
    let grown = try decode(replayed)
    XCTAssertEqual(rowText(grown, 7), row12)
    XCTAssertEqual(rowText(grown, 11), "")
  }

  /// The garble fix: keep the bytes, throw the short emulator away, replay at
  /// the size the TUI actually painted. Row 12 lands on row 12, not as a
  /// clamped overwrite of row 8 with empty rows under it.
  func testRebuildFromBufferAtGrownSizeRestoresEveryRow() throws {
    var buffer = TerminalOutputBuffer()
    buffer.append(altScreenBytes(cols: cols, rows: grownRows))
    let short = buffer.replay(cols: cols, rows: rows)
    XCTAssertEqual(
      rowText(try decode(short), 7),
      row12,
      "the short replay is still clamped — the buffer must not mutate that"
    )
    let grown = buffer.replay(cols: cols, rows: grownRows)
    let snapshot = try decode(grown)
    XCTAssertEqual(rowText(snapshot, 0), row1)
    XCTAssertEqual(rowText(snapshot, 7), row8)
    XCTAssertEqual(rowText(snapshot, 11), row12)
    XCTAssertEqual(
      TerminalGridLayout.paintedRows(
        cells: snapshot.cells,
        cols: Int(snapshot.header.cols),
        rows: Int(snapshot.header.rows),
        altScreen: snapshot.header.altScreen
      ),
      Int(grownRows),
      "a recovered alt-screen fill has no trailing slack, so pan is unnecessary"
    )
  }

  /// After a recovered full paint, alt-screen scroll is still a no-op — and
  /// that is fine, because there is no gap left to close.
  func testRecoveredAltScreenHasNoGapForPanToClose() throws {
    var buffer = TerminalOutputBuffer()
    buffer.append(altScreenBytes(cols: cols, rows: grownRows))
    let grown = buffer.replay(cols: cols, rows: grownRows)
    grown.scrollViewport(lines: 40)
    grown.scrollViewport(lines: -40)
    let snapshot = try decode(grown)
    XCTAssertEqual(rowText(snapshot, 0), row1)
    XCTAssertEqual(rowText(snapshot, 11), row12)
  }

  /// Noise `start` does not replay logs. Switching sessions used to install a
  /// fresh emulator, then Cursor Agent's SIGWINCH redraw only CUP-paints the
  /// composer. That is the void under the input box.
  func testAPartialRepaintIntoAFreshEmulatorLeavesTheVoid() throws {
    let emulator = FfiTerminalEmulator(cols: cols, rows: grownRows)
    emulator.feed(bytes: composerLineBytes())
    let snapshot = try decode(emulator)
    XCTAssertEqual(rowText(snapshot, 0), "helloxxxxxxxxxxxxxxx")
    XCTAssertEqual(rowText(snapshot, 11), "")
  }

  /// Keep the emulator across the switch and the same composer CUP overlays
  /// row 1 without wiping the rest of the TUI.
  func testAPartialRepaintIntoAKeptEmulatorKeepsTheTui() throws {
    let emulator = FfiTerminalEmulator(cols: cols, rows: grownRows)
    emulator.feed(bytes: altScreenBytes(cols: cols, rows: grownRows))
    emulator.feed(bytes: composerLineBytes())
    let snapshot = try decode(emulator)
    XCTAssertEqual(rowText(snapshot, 0), "helloxxxxxxxxxxxxxxx")
    XCTAssertEqual(rowText(snapshot, 11), row12)
  }

  // MARK: - Helpers

  private struct Decoded {
    var header: GridSnapshot.Header
    var cells: [GridSnapshot.Cell]
  }

  private func altScreenBytes(cols: UInt16, rows: UInt16) -> Data {
    var bytes = Data("\u{1B}[?1049h\u{1B}[2J".utf8)
    for row in 1...rows {
      let label = "R\(row)"
      let fill = String(repeating: "x", count: max(0, Int(cols) - label.count))
      bytes.append(contentsOf: "\u{1B}[\(row);1H\(label)\(fill)".utf8)
    }
    return bytes
  }

  /// One CUP-addressed line at row 1 — what a TUI sends on SIGWINCH when it
  /// only dirty-paints the composer.
  private func composerLineBytes() -> Data {
    let fill = String(repeating: "x", count: 15)
    return Data("\u{1B}[1;1Hhello\(fill)".utf8)
  }

  private func decode(_ emulator: FfiTerminalEmulator) throws -> Decoded {
    let (header, cells) = try GridSnapshotDecoder.decode(emulator.snapshot())
    return Decoded(header: header, cells: cells)
  }

  private func rowText(_ snapshot: Decoded, _ row: Int) -> String {
    let cols = Int(snapshot.header.cols)
    let start = row * cols
    let scalars = snapshot.cells[start..<(start + cols)].map { cell -> Character in
      Character(UnicodeScalar(cell.codepoint) ?? " ")
    }
    return String(scalars).trimmingCharacters(in: .whitespaces)
  }
}
