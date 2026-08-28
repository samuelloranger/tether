import Foundation

/// Pure Swift TGRD decoder for the render loop. Avoids a UniFFI round-trip per frame.
public enum GridSnapshotDecoder {
  public static func decode(_ bytes: Data) throws -> (GridSnapshot.Header, [GridSnapshot.Cell]) {
    guard bytes.count >= GridSnapshot.headerSize else {
      throw GridSnapshot.DecodeError.tooShort
    }
    // ONE `withUnsafeBytes` for the whole buffer. The previous version opened a
    // fresh one per field — four per cell — so a 60x40 grid paid ~9600 of them
    // on every frame, on the main thread, in the middle of the render path.
    return try bytes.withUnsafeBytes { raw in
      try decode(raw: raw, count: bytes.count)
    }
  }

  private static func decode(
    raw: UnsafeRawBufferPointer,
    count: Int
  ) throws -> (GridSnapshot.Header, [GridSnapshot.Cell]) {
    let magic = raw.loadUnaligned(fromByteOffset: 0, as: UInt32.self).littleEndian
    guard magic == GridSnapshot.magic else {
      throw GridSnapshot.DecodeError.badMagic
    }

    let version = raw.loadUnaligned(fromByteOffset: 4, as: UInt16.self).littleEndian
    guard version == GridSnapshot.version else {
      throw GridSnapshot.DecodeError.badVersion(version)
    }

    let cols = raw.loadUnaligned(fromByteOffset: 6, as: UInt16.self).littleEndian
    let rows = raw.loadUnaligned(fromByteOffset: 8, as: UInt16.self).littleEndian
    let cursorCol = raw.loadUnaligned(fromByteOffset: 10, as: UInt16.self).littleEndian
    let cursorRow = raw.loadUnaligned(fromByteOffset: 12, as: UInt16.self).littleEndian
    let generation = raw.loadUnaligned(fromByteOffset: 14, as: UInt64.self).littleEndian
    let flags = raw.loadUnaligned(fromByteOffset: 22, as: UInt16.self).littleEndian

    let expected = GridSnapshot.bufferSize(cols: cols, rows: rows)
    guard count == expected else {
      throw GridSnapshot.DecodeError.sizeMismatch(length: count, cols: cols, rows: rows)
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
    // Written straight into uninitialized storage: the cell count is known
    // exactly, so `append` per cell only buys a capacity check per iteration.
    let cells = [GridSnapshot.Cell](unsafeUninitializedCapacity: cellCount) { buffer, initialized in
      for index in 0..<cellCount {
        let offset = GridSnapshot.headerSize + index * GridSnapshot.cellStride
        buffer.baseAddress?.advanced(by: index).initialize(
          to: GridSnapshot.Cell(
            codepoint: raw.loadUnaligned(fromByteOffset: offset, as: UInt32.self).littleEndian,
            foreground: raw.loadUnaligned(fromByteOffset: offset + 4, as: UInt32.self).littleEndian,
            background: raw.loadUnaligned(fromByteOffset: offset + 8, as: UInt32.self).littleEndian,
            attrs: raw.loadUnaligned(fromByteOffset: offset + 12, as: UInt32.self).littleEndian
          )
        )
      }
      initialized = cellCount
    }

    return (header, cells)
  }
}
