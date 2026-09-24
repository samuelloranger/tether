import Foundation

/// Which palette entries a program has set itself (OSC 4), read from the output before
/// SwiftTerm parses it: the terminal reports a set and a reset of one entry through the
/// same callback, so a theme switch could not otherwise tell them apart.
struct PaletteOverrides {
  private(set) var indices: Set<Int> = []

  private enum State { case ground, escape, code, body, bodyEscape }
  private var state = State.ground
  private var code = ""
  private var body: [UInt8] = []
  /// An OSC longer than this is not a palette command; it is skipped, not buffered.
  private static let bodyLimit = 4096

  mutating func scan(_ bytes: some Sequence<UInt8>) {
    for byte in bytes { step(byte) }
  }

  private mutating func step(_ byte: UInt8) {
    switch state {
    case .ground:
      if byte == 0x1B { state = .escape }
    case .escape:
      switch byte {
      case UInt8(ascii: "]"): state = .code; code = ""; body = []
      // RIS puts the whole palette back.
      case UInt8(ascii: "c"): indices.removeAll(); state = .ground
      case 0x1B: break
      default: state = .ground
      }
    case .code:
      switch byte {
      case UInt8(ascii: "0")...UInt8(ascii: "9") where code.count < 5: code.append(Character(Unicode.Scalar(byte)))
      case UInt8(ascii: ";"): state = .body
      case 0x07: finish()
      case 0x1B: state = .bodyEscape
      default: state = .ground
      }
    case .body:
      switch byte {
      case 0x07: finish()
      case 0x1B: state = .bodyEscape
      default: if body.count < Self.bodyLimit { body.append(byte) }
      }
    case .bodyEscape:
      if byte == UInt8(ascii: "\\") {
        finish()
      } else {
        // ESC starts a new sequence; this OSC was cut short.
        state = .escape
        step(byte)
      }
    }
  }

  private mutating func finish() {
    state = .ground
    guard body.count < Self.bodyLimit else { return }
    let fields = String(decoding: body, as: UTF8.self).split(separator: ";", omittingEmptySubsequences: false)
    switch code {
    case "4":
      // index;spec pairs; a "?" spec is a query and changes nothing.
      var pairs = fields.makeIterator()
      while let index = pairs.next(), let spec = pairs.next() {
        guard let value = Int(index), (0..<256).contains(value), spec != "?" else { continue }
        indices.insert(value)
      }
    case "104":
      if fields.allSatisfy({ $0.isEmpty }) {
        indices.removeAll()
      } else {
        for field in fields { if let value = Int(field) { indices.remove(value) } }
      }
    default:
      break
    }
  }
}
