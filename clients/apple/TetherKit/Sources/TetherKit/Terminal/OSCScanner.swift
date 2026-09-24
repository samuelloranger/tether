import Foundation

/// Finds OSC sequences (and RIS) in terminal output as it arrives, across read boundaries,
/// for the few that Tether must see before SwiftTerm parses them. DCS, APC, PM and SOS
/// payloads — kitty graphics among them — are skipped whole, so an `ESC ]` inside one is
/// never mistaken for a command.
struct OSCScanner {
  enum Event: Equatable {
    /// `end` is the offset just past the terminator within the scanned bytes.
    case osc(code: String, body: [UInt8], end: Int)
    case reset(end: Int)
  }

  private enum State { case ground, escape, code, body, bodyEscape, string, stringEscape }
  private var state = State.ground
  private var code = ""
  private var body: [UInt8] = []
  private var overflowed = false
  /// Commands Tether reads are short; a longer body is dropped rather than buffered.
  static let bodyLimit = 4096

  mutating func scan(_ bytes: [UInt8]) -> [Event] {
    var events: [Event] = []
    for (offset, byte) in bytes.enumerated() {
      if let event = step(byte, end: offset + 1) { events.append(event) }
    }
    return events
  }

  private mutating func step(_ byte: UInt8, end: Int) -> Event? {
    switch state {
    case .ground:
      if byte == 0x1B { state = .escape }
    case .escape:
      switch byte {
      case UInt8(ascii: "]"): state = .code; code = ""; body = []; overflowed = false
      case UInt8(ascii: "P"), UInt8(ascii: "_"), UInt8(ascii: "^"), UInt8(ascii: "X"): state = .string
      case UInt8(ascii: "c"): state = .ground; return .reset(end: end)
      case 0x1B: break
      default: state = .ground
      }
    case .code:
      switch byte {
      case UInt8(ascii: "0")...UInt8(ascii: "9") where code.count < 5: code.append(Character(Unicode.Scalar(byte)))
      case UInt8(ascii: ";"): state = .body
      case 0x07: return finish(end: end)
      case 0x1B: state = .bodyEscape
      default: state = .ground
      }
    case .body:
      switch byte {
      case 0x07: return finish(end: end)
      case 0x1B: state = .bodyEscape
      default:
        if body.count < Self.bodyLimit { body.append(byte) } else { overflowed = true }
      }
    case .bodyEscape:
      if byte == UInt8(ascii: "\\") { return finish(end: end) }
      // ESC starts a new sequence; this OSC was cut short.
      state = .escape
      return step(byte, end: end)
    case .string:
      if byte == 0x1B { state = .stringEscape }
    case .stringEscape:
      state = byte == UInt8(ascii: "\\") ? .ground : .string
    }
    return nil
  }

  private mutating func finish(end: Int) -> Event? {
    state = .ground
    return overflowed || code.isEmpty ? nil : .osc(code: code, body: body, end: end)
  }
}
