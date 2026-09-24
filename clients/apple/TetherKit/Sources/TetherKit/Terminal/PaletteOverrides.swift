import Foundation

/// Which palette entries a program has set itself (OSC 4), from the output as it arrives:
/// SwiftTerm reports a set and a reset of one entry through the same callback, so a theme
/// switch could not otherwise tell them apart. Fed the events of the engine's `OSCScanner`,
/// which already skips control-string payloads.
struct PaletteOverrides {
  private(set) var indices: Set<Int> = []

  mutating func apply(_ event: OSCScanner.Event) {
    switch event {
    // RIS puts the whole palette back.
    case .reset:
      indices.removeAll()
    case let .osc("4", body, _):
      // index;spec pairs; a "?" spec is a query and changes nothing.
      var pairs = fields(body).makeIterator()
      while let index = pairs.next(), let spec = pairs.next() {
        guard let value = Int(index), (0..<256).contains(value), spec != "?" else { continue }
        indices.insert(value)
      }
    case let .osc("104", body, _):
      let entries = fields(body)
      if entries.allSatisfy({ $0.isEmpty }) {
        indices.removeAll()
      } else {
        for entry in entries { if let value = Int(entry) { indices.remove(value) } }
      }
    default:
      break
    }
  }

  /// Entries carried over from another engine, e.g. one a resize rebuilt from truncated output.
  mutating func adopt(_ carried: [Int]) {
    indices.formUnion(carried)
  }

  private func fields(_ body: [UInt8]) -> [Substring] {
    String(decoding: body, as: UTF8.self).split(separator: ";", omittingEmptySubsequences: false)
  }
}
