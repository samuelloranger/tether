import Foundation

/// URL / file-path link spans over a terminal grid — port of `apps/mobile/src/links.ts`.

public enum LinkTarget: Equatable, Sendable {
  case external(url: String)
  case file(path: String, line: Int?, column: Int?)

  /// What a copy of the link puts on the pasteboard: the URL, or `path:line:column`.
  public var text: String {
    switch self {
    case let .external(url):
      return url
    case let .file(path, line, column):
      return [path, line.map(String.init), column.map(String.init)].compactMap { $0 }.joined(separator: ":")
    }
  }
}

public struct LinkSpan: Equatable, Sendable {
  public var start: Int
  public var end: Int
  public var target: LinkTarget

  public init(start: Int, end: Int, target: LinkTarget) {
    self.start = start
    self.end = end
    self.target = target
  }
}

public enum LinkSpans {
  private static let urlRegex = try! NSRegularExpression(pattern: #"https?://[^\s│┃]+"#)
  // The lookbehind keeps a match from starting mid-token, so a URL's own path is not re-read
  // as a file. Absolute paths need two components, so a lone `/help` stays plain text.
  private static let fileRegex = try! NSRegularExpression(
    pattern: #"(?<![\w/.:@+-])((?:(?:~|\.{1,2})(?:/[\w.@+-]+)+|(?:/[\w.@+-]+){2,}|(?:[\w.@+-]+/)+[\w.@+-]+)(?::[1-9]\d*(?::[1-9]\d*)?)?)(?![\w/@+-])"#
  )
  private static let filePathRegex = try! NSRegularExpression(
    pattern: #"^(.*?)(?::([1-9]\d*)(?::([1-9]\d*))?)?$"#
  )
  private static let hasFileExtRegex = try! NSRegularExpression(pattern: #"/[\w.@+-]+\.[\w-]+$"#)
  private static let urlAtEolRegex = try! NSRegularExpression(pattern: #"(?:^|\s)https?://\S{8,}$"#)
  private static let urlContRegex = try! NSRegularExpression(
    pattern: #"^[A-Za-z0-9\-._~%+:@]*[/?#&=][^\s]*"#
  )

  private static func trimFileEnd(_ token: String) -> String {
    var clean = token
    let trailing: Set<Character> = [")", "]", ",", ";", "."]
    while let last = clean.last, trailing.contains(last) {
      clean.removeLast()
    }
    return clean
  }

  public static func parseFileTarget(_ token: String) -> LinkTarget? {
    let clean = trimFileEnd(token)
    let range = NSRange(clean.startIndex..., in: clean)
    guard let match = filePathRegex.firstMatch(in: clean, range: range),
          match.numberOfRanges >= 2,
          let pathRange = Range(match.range(at: 1), in: clean)
    else { return nil }
    let path = String(clean[pathRange])
    guard path.contains("/") else { return nil }
    // A bare relative `a/b` is as likely prose or a date as a path; only an extension makes it one.
    let anchored = path.hasPrefix("/") || path.hasPrefix("~") || path.hasPrefix(".")
    if !anchored, hasFileExtRegex.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)) == nil {
      return nil
    }
    var line: Int?
    var column: Int?
    if match.numberOfRanges > 2, let r = Range(match.range(at: 2), in: clean) {
      line = Int(clean[r])
    }
    if match.numberOfRanges > 3, let r = Range(match.range(at: 3), in: clean) {
      column = Int(clean[r])
    }
    return .file(path: path, line: line, column: column)
  }

  /// `texts[i]` is row i's plain text; `wrapped[i]` is true when row i soft-wraps
  /// into row i+1. Returns one `[LinkSpan]` per row.
  public static func compute(texts: [String], wrapped: [Bool]) -> [[LinkSpan]] {
    var out: [[LinkSpan]] = texts.map { _ in [] }
    var i = 0
    while i < texts.count {
      var j = i
      var skips: [Int] = [0]
      var tails: [Int] = []
      while j + 1 < texts.count {
        if j < wrapped.count, wrapped[j] {
          skips.append(0)
          tails.append(0)
          j += 1
          continue
        }
        let skip = hardWrapSkip(row: texts[j], next: texts[j + 1])
        if skip < 0 { break }
        skips.append(skip)
        tails.append(trailingBorder(texts[j]))
        j += 1
      }
      tails.append(0)

      var parts: [String] = []
      var offs: [Int] = []
      var acc = 0
      for k in i...j {
        let skip = skips[k - i]
        let tail = tails[k - i]
        let text = texts[k]
        var part = Substring(text)
        if skip > 0, skip <= part.count { part = part.dropFirst(skip) }
        if tail > 0, tail <= part.count { part = part.dropLast(tail) }
        parts.append(String(part))
        offs.append(acc)
        acc += part.count
      }
      let joined = parts.joined()
      let fullRange = NSRange(joined.startIndex..., in: joined)

      var urlRanges: [Range<Int>] = []
      for match in urlRegex.matches(in: joined, range: fullRange) {
        guard let r = Range(match.range, in: joined) else { continue }
        let url = trimUrlEnd(String(joined[r]))
        guard !url.isEmpty else { continue }
        let s = joined.distance(from: joined.startIndex, to: r.lowerBound)
        let e = s + url.count
        urlRanges.append(s..<e)
        push(target: .external(url: url), s: s, e: e, i: i, j: j, skips: skips, parts: parts, offs: offs, out: &out)
      }

      for match in fileRegex.matches(in: joined, range: fullRange) {
        guard match.numberOfRanges >= 2,
              let rawRange = Range(match.range(at: 1), in: joined)
        else { continue }
        let raw = String(joined[rawRange])
        guard let target = parseFileTarget(raw) else { continue }
        let s = joined.distance(from: joined.startIndex, to: rawRange.lowerBound)
        let e = s + trimFileEnd(raw).count
        guard !urlRanges.contains(where: { $0.overlaps(s..<e) }) else { continue }
        push(target: target, s: s, e: e, i: i, j: j, skips: skips, parts: parts, offs: offs, out: &out)
      }

      i = j + 1
    }
    return out
  }

  /// OSC 8 links win over text that merely looks like a link: `target` returns the first
  /// span that covers a cell.
  public static func merging(explicit: [[LinkSpan]], detected: [[LinkSpan]]) -> [[LinkSpan]] {
    guard !explicit.isEmpty else { return detected }
    return detected.indices.map { row in
      (row < explicit.count ? explicit[row] : []) + detected[row]
    }
  }

  public static func target(atColumn col: Int, row: Int, spans: [[LinkSpan]]) -> LinkTarget? {
    guard row >= 0, row < spans.count else { return nil }
    for span in spans[row] where col >= span.start && col < span.end {
      return span.target
    }
    return nil
  }

  private static func push(
    target: LinkTarget,
    s: Int,
    e: Int,
    i: Int,
    j: Int,
    skips: [Int],
    parts: [String],
    offs: [Int],
    out: inout [[LinkSpan]]
  ) {
    for k in i...j {
      let skip = skips[k - i]
      let rowStart = offs[k - i]
      let rowEnd = rowStart + parts[k - i].count
      let a = max(s, rowStart)
      let b = min(e, rowEnd)
      if a < b {
        out[k].append(LinkSpan(start: a - rowStart + skip, end: b - rowStart + skip, target: target))
      }
    }
  }

  private static func trimUrlEnd(_ url: String) -> String {
    var url = url
    while let ch = url.last {
      if ch == ")" {
        let opens = url.filter { $0 == "(" }.count
        let closes = url.filter { $0 == ")" }.count
        if closes <= opens { break }
      } else if !".,;:!?'\"]}>".contains(ch) {
        break
      }
      url.removeLast()
    }
    return url
  }

  /// Box-drawing a TUI frames its output with (`│ … │`, Claude Code's `⎿`): a URL it wraps
  /// continues past these, not through them.
  private static let borders: Set<Character> = ["│", "┃", "⎿"]

  /// Characters to drop from the end of a row that closes on a box border.
  private static func trailingBorder(_ row: String) -> Int {
    var body = Substring(row)
    while let last = body.last, last.isWhitespace { body.removeLast() }
    guard let last = body.last, borders.contains(last), last != "⎿" else { return 0 }
    body.removeLast()
    while let last = body.last, last.isWhitespace { body.removeLast() }
    return row.count - body.count
  }

  private static func hardWrapSkip(row: String, next: String) -> Int {
    let body = String(row.dropLast(trailingBorder(row)))
    guard urlAtEolRegex.firstMatch(in: body, range: NSRange(body.startIndex..., in: body)) != nil else { return -1 }
    let lead = next.prefix { $0.isWhitespace || borders.contains($0) }.count
    let rest = String(next.dropFirst(lead))
    guard !rest.isEmpty else { return -1 }
    guard urlContRegex.firstMatch(in: rest, range: NSRange(rest.startIndex..., in: rest)) != nil else { return -1 }
    return lead
  }
}
