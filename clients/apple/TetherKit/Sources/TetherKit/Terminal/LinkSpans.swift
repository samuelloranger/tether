import Foundation

/// URL / file-path link spans over a terminal grid — port of `apps/mobile/src/links.ts`.

public enum LinkTarget: Equatable, Sendable {
  case external(url: String)
  case file(path: String, line: Int?, column: Int?)
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
  private static let urlRegex = try! NSRegularExpression(pattern: #"https?://[^\s]+"#)
  private static let fileRegex = try! NSRegularExpression(
    pattern: #"(?:^|\s)((?:[\w.-]+/)+[\w.-]+\.[\w-]+(?::[1-9]\d*(?::[1-9]\d*)?)?)(?=$|\s|[)\],;.])"#
  )
  private static let filePathRegex = try! NSRegularExpression(
    pattern: #"^(.*?)(?::([1-9]\d*)(?::([1-9]\d*))?)?$"#
  )
  private static let hasFileExtRegex = try! NSRegularExpression(pattern: #"/[\w.-]+\.[\w-]+$"#)
  private static let urlAtEolRegex = try! NSRegularExpression(pattern: #"(?:^|\s)https?://\S{8,}$"#)
  private static let urlContRegex = try! NSRegularExpression(
    pattern: #"^[A-Za-z0-9\-._~%+:@]*[/?#&=][^\s]*"#
  )

  public static func parseFileTarget(_ token: String) -> LinkTarget? {
    var clean = token
    let trailing: Set<Character> = [")", "]", ",", ";", "."]
    while let last = clean.last, trailing.contains(last) {
      clean.removeLast()
    }
    let range = NSRange(clean.startIndex..., in: clean)
    guard let match = filePathRegex.firstMatch(in: clean, range: range),
          match.numberOfRanges >= 2,
          let pathRange = Range(match.range(at: 1), in: clean)
    else { return nil }
    let path = String(clean[pathRange])
    guard path.contains("/"),
          hasFileExtRegex.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)) != nil
    else { return nil }
    if path.hasPrefix("/") || path.split(separator: "/").contains("..") { return nil }
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
      while j + 1 < texts.count {
        if j < wrapped.count, wrapped[j] {
          skips.append(0)
          j += 1
          continue
        }
        let skip = hardWrapSkip(row: texts[j], next: texts[j + 1])
        if skip < 0 { break }
        skips.append(skip)
        j += 1
      }

      var parts: [String] = []
      var offs: [Int] = []
      var acc = 0
      for k in i...j {
        let skip = skips[k - i]
        let text = texts[k]
        let part: String
        if skip > 0, skip <= text.count {
          part = String(text.dropFirst(skip))
        } else {
          part = text
        }
        parts.append(part)
        offs.append(acc)
        acc += part.count
      }
      let joined = parts.joined()
      let fullRange = NSRange(joined.startIndex..., in: joined)

      for match in urlRegex.matches(in: joined, range: fullRange) {
        guard let r = Range(match.range, in: joined) else { continue }
        let url = trimUrlEnd(String(joined[r]))
        guard !url.isEmpty else { continue }
        let s = joined.distance(from: joined.startIndex, to: r.lowerBound)
        let e = s + url.count
        push(target: .external(url: url), s: s, e: e, i: i, j: j, skips: skips, parts: parts, offs: offs, out: &out)
      }

      for match in fileRegex.matches(in: joined, range: fullRange) {
        guard match.numberOfRanges >= 2,
              let rawRange = Range(match.range(at: 1), in: joined)
        else { continue }
        let raw = String(joined[rawRange])
        guard let target = parseFileTarget(raw) else { continue }
        let s = joined.distance(from: joined.startIndex, to: rawRange.lowerBound)
        let e = s + raw.count
        push(target: target, s: s, e: e, i: i, j: j, skips: skips, parts: parts, offs: offs, out: &out)
      }

      i = j + 1
    }
    return out
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

  private static func hardWrapSkip(row: String, next: String) -> Int {
    let rowRange = NSRange(row.startIndex..., in: row)
    guard urlAtEolRegex.firstMatch(in: row, range: rowRange) != nil else { return -1 }
    let trimmed = next.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return -1 }
    let bodyRange = NSRange(trimmed.startIndex..., in: trimmed)
    guard urlContRegex.firstMatch(in: trimmed, range: bodyRange) != nil else { return -1 }
    return next.count - trimmed.count
  }
}
