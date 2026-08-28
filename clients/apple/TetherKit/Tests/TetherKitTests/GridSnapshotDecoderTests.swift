import XCTest
@testable import TetherKit

/// The decoder runs on every rendered frame, so it was rewritten to open one
/// `withUnsafeBytes` for the whole buffer instead of four per cell. These pin
/// the wire format so that rewrite — and the next one — cannot quietly shift a
/// field offset.
final class GridSnapshotDecoderTests: XCTestCase {
  private func encode(
    cols: UInt16,
    rows: UInt16,
    cursorCol: UInt16 = 0,
    cursorRow: UInt16 = 0,
    generation: UInt64 = 0,
    cursorVisible: Bool = true,
    cells: [GridSnapshot.Cell],
    magic: UInt32 = GridSnapshot.magic,
    version: UInt16 = GridSnapshot.version
  ) -> Data {
    var data = Data()
    func put<T: FixedWidthInteger>(_ value: T) {
      var little = value.littleEndian
      withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
    }
    put(magic)
    put(version)
    put(cols)
    put(rows)
    put(cursorCol)
    put(cursorRow)
    put(generation)
    put(cursorVisible ? GridSnapshot.flagCursorVisible : UInt16(0))
    XCTAssertEqual(data.count, GridSnapshot.headerSize)
    for cell in cells {
      put(cell.codepoint)
      put(cell.foreground)
      put(cell.background)
      put(cell.attrs)
    }
    return data
  }

  private func cell(_ codepoint: UInt32) -> GridSnapshot.Cell {
    GridSnapshot.Cell(
      codepoint: codepoint,
      foreground: 0xFF11_2233,
      background: 0xFF44_5566,
      attrs: GridSnapshot.attrBold | GridSnapshot.attrUnderline
    )
  }

  func testRoundTripsHeaderAndEveryCellInOrder() throws {
    let cells = (0..<6).map { cell(UInt32(0x41 + $0)) }
    let data = encode(
      cols: 3,
      rows: 2,
      cursorCol: 2,
      cursorRow: 1,
      generation: 987_654_321,
      cells: cells
    )

    let (header, decoded) = try GridSnapshotDecoder.decode(data)

    XCTAssertEqual(header.cols, 3)
    XCTAssertEqual(header.rows, 2)
    XCTAssertEqual(header.cursorCol, 2)
    XCTAssertEqual(header.cursorRow, 1)
    XCTAssertEqual(header.generation, 987_654_321)
    XCTAssertTrue(header.cursorVisible)
    // Order is the whole contract: cell N is row N/cols, column N%cols.
    XCTAssertEqual(decoded, cells)
  }

  func testCursorHiddenWhenFlagIsClear() throws {
    let data = encode(cols: 1, rows: 1, cursorVisible: false, cells: [cell(0x20)])
    XCTAssertFalse(try GridSnapshotDecoder.decode(data).0.cursorVisible)
  }

  func testEmptyGridDecodesToNoCells() throws {
    let data = encode(cols: 0, rows: 0, cells: [])
    let (header, cells) = try GridSnapshotDecoder.decode(data)
    XCTAssertEqual(header.cols, 0)
    XCTAssertTrue(cells.isEmpty)
  }

  func testRejectsShortBuffer() {
    let data = Data(repeating: 0, count: GridSnapshot.headerSize - 1)
    XCTAssertThrowsError(try GridSnapshotDecoder.decode(data)) { error in
      XCTAssertEqual(error as? GridSnapshot.DecodeError, .tooShort)
    }
  }

  func testRejectsBadMagic() {
    let data = encode(cols: 1, rows: 1, cells: [cell(0x41)], magic: 0xDEAD_BEEF)
    XCTAssertThrowsError(try GridSnapshotDecoder.decode(data)) { error in
      XCTAssertEqual(error as? GridSnapshot.DecodeError, .badMagic)
    }
  }

  func testRejectsUnknownVersion() {
    let data = encode(cols: 1, rows: 1, cells: [cell(0x41)], version: 99)
    XCTAssertThrowsError(try GridSnapshotDecoder.decode(data)) { error in
      XCTAssertEqual(error as? GridSnapshot.DecodeError, .badVersion(99))
    }
  }

  func testRejectsTruncatedCellData() {
    var data = encode(cols: 4, rows: 4, cells: (0..<16).map { cell(UInt32($0)) })
    data.removeLast(GridSnapshot.cellStride)
    XCTAssertThrowsError(try GridSnapshotDecoder.decode(data)) { error in
      XCTAssertEqual(
        error as? GridSnapshot.DecodeError,
        .sizeMismatch(length: data.count, cols: 4, rows: 4)
      )
    }
  }
}
