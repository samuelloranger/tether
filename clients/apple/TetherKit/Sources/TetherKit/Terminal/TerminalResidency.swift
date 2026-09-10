/// Pure residency policy for background terminal sockets: which sessions stay
/// live, and how recency is tracked. Kept separate from `SessionStore` so it is
/// testable without an actor or a Noise connection.
enum TerminalResidency {
  /// New recency order, `touched` first, de-duplicated, capped to `max`.
  static func touch(_ order: [String], _ touched: String, max: Int = 64) -> [String] {
    Array(([touched] + order.filter { $0 != touched }).prefix(max))
  }

  /// Keys to keep resident: `active` always first, then the recency order
  /// restricted to `live`, up to `cap` total.
  static func resident(active: String, order: [String], live: Set<String>, cap: Int) -> [String] {
    var out: [String] = live.contains(active) ? [active] : []
    var seen = Set(out)
    for key in order {
      if out.count >= cap { break }
      if live.contains(key), !seen.contains(key) {
        out.append(key)
        seen.insert(key)
      }
    }
    return out
  }
}
