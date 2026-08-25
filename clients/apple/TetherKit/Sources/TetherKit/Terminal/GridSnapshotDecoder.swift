import Foundation

/// Pure Swift TGRD decoder for the render loop. Avoids a UniFFI round-trip per frame.
public enum GridSnapshotDecoder {
  public static func decode(_ bytes: Data) throws -> (GridSnapshot.Header, [GridSnapshot.Cell]) {
    guard bytes.count >= GridSnapshot.headerSize else {
      throw GridSnapshot.DecodeError.tooShort
    }

    let magic = bytes.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 0, as: UInt32.self) }
      .littleEndian
    guard magic == GridSnapshot.magic else {
      throw GridSnapshot.DecodeError.badMagic
    }

    let version = bytes.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 4, as: UInt16.self) }
      .littleEndian
    guard version == GridSnapshot.version else {
      throw GridSnapshot.DecodeError.badVersion(version)
    }

    let cols = bytes.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 6, as: UInt16.self) }
      .littleEndian
    let rows = bytes.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 8, as: UInt16.self) }
      .littleEndian
    let cursorCol = bytes.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 10, as: UInt16.self) }
      .littleEndian
    let cursorRow = bytes.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 12, as: UInt16.self) }
      .littleEndian
    let generation = bytes.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 14, as: UInt64.self) }
      .littleEndian
    let flags = bytes.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 22, as: UInt16.self) }
      .littleEndian

    let expected = GridSnapshot.bufferSize(cols: cols, rows: rows)
    guard bytes.count == expected else {
      throw GridSnapshot.DecodeError.sizeMismatch(length: bytes.count, cols: cols, rows: rows)
    }

    let header = GridSnapshot.Header(
      cols: cols,
      rows: rows,
      cursorCol: cursorCol,
      cursorRow: cursorRow,
      generation: generation,
      cursorVisible: flags & GridSnapshot.flagCursorVisible != 0
    )

    let cellCount = Int(cols) * Int(rows)
    var cells = [GridSnapshot.Cell]()
    cells.reserveCapacity(cellCount)

    for index in 0..<cellCount {
      let offset = GridSnapshot.headerSize + index * GridSnapshot.cellStride
      let codepoint = bytes.withUnsafeBytes {
        $0.loadUnaligned(fromByteOffset: offset, as: UInt32.self)
      }.littleEndian
      let fg = bytes.withUnsafeBytes {
        $0.loadUnaligned(fromByteOffset: offset + 4, as: UInt32.self)
      }.littleEndian
      let bg = bytes.withUnsafeBytes {
        $0.loadUnaligned(fromByteOffset: offset + 8, as: UInt32.self)
      }.littleEndian
      let attrs = bytes.withUnsafeBytes {
        $0.loadUnaligned(fromByteOffset: offset + 12, as: UInt32.self)
      }.littleEndian
      cells.append(GridSnapshot.Cell(codepoint: codepoint, foreground: fg, background: bg, attrs: attrs))
    }

    return (header, cells)
  }
}
