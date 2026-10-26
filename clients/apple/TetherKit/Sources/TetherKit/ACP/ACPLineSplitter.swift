import Foundation

struct ACPLine: Equatable, Sendable {
  var bytes: Data
  /// Byte offsets of the line in the stream, newline included in `end`.
  var start: Int
  var end: Int
}

enum ACPLineError: Error, Equatable {
  case lineTooLong(limit: Int)
}

/// Splits on 0x0A bytes, never on decoded characters, so a multi-byte UTF-8 character cut by a
/// chunk boundary stays whole in the line it belongs to.
struct ACPLineSplitter {
  static let defaultMaxLineBytes = 16 * 1024 * 1024

  private let maxLineBytes: Int
  private var buffer = Data()
  private var bufferStart: Int
  private var failed = false

  init(maxLineBytes: Int = defaultMaxLineBytes, startOffset: Int = 0) {
    self.maxLineBytes = maxLineBytes
    self.bufferStart = startOffset
  }

  mutating func feed(_ chunk: Data) throws -> [ACPLine] {
    if failed { throw ACPLineError.lineTooLong(limit: maxLineBytes) }
    buffer.append(chunk)
    var lines: [ACPLine] = []
    var consumed = 0
    while let newline = buffer[(buffer.startIndex + consumed)...].firstIndex(of: 0x0A) {
      let lineStart = buffer.startIndex + consumed
      var body = buffer[lineStart..<newline]
      if body.last == 0x0D { body = body.dropLast() }
      let length = newline - lineStart
      if length > maxLineBytes { return try fail() }
      if !body.isEmpty {
        lines.append(ACPLine(
          bytes: Data(body), start: bufferStart + consumed, end: bufferStart + consumed + length + 1))
      }
      consumed += length + 1
    }
    buffer.removeFirst(consumed)
    bufferStart += consumed
    if buffer.count > maxLineBytes { return try fail() }
    return lines
  }

  private mutating func fail() throws -> [ACPLine] {
    failed = true
    buffer = Data()
    throw ACPLineError.lineTooLong(limit: maxLineBytes)
  }
}
