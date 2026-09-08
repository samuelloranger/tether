import Foundation

/// Builds a minimal unified diff (single hunk, line numbers from 1) between two
/// text blobs so an Edit/Write tool call renders as a diff card instead of raw
/// JSON. An LCS over lines — not a full Myers diff — is enough for the short
/// snippets an Edit carries, and it keeps unchanged lines as context.
public func unifiedLineDiff(old: String, new: String) -> String {
  // Fast paths: a brand-new Write (old empty) or a full delete (new empty) need
  // no LCS at all — every line is a straight add/remove. Skipping `lcsDiffOps`
  // here matters because its DP table is O(n·m); a large file otherwise pays
  // that cost just to render a diff that has no context lines to find.
  if old.isEmpty {
    let newLines = new.isEmpty ? [] : new.components(separatedBy: "\n")
    guard !newLines.isEmpty else { return "" }
    let header = "@@ -0,0 +1,\(newLines.count) @@"
    return ([header] + newLines.map { "+" + $0 }).joined(separator: "\n")
  }
  if new.isEmpty {
    let oldLines = old.components(separatedBy: "\n")
    let header = "@@ -1,\(oldLines.count) +0,0 @@"
    return ([header] + oldLines.map { "-" + $0 }).joined(separator: "\n")
  }

  let oldLines = old.components(separatedBy: "\n")
  let newLines = new.components(separatedBy: "\n")
  let ops = lcsDiffOps(oldLines, newLines)
  let changed = ops.contains {
    if case .context = $0 { return false }
    return true
  }
  guard changed else { return "" }

  var body: [String] = []
  for op in ops {
    switch op {
    case let .context(line): body.append(" " + line)
    case let .remove(line): body.append("-" + line)
    case let .add(line): body.append("+" + line)
    }
  }
  let header = "@@ -1,\(max(oldLines.count, 1)) +1,\(max(newLines.count, 1)) @@"
  return ([header] + body).joined(separator: "\n")
}

enum LineDiffOp: Equatable {
  case context(String)
  case remove(String)
  case add(String)
}

/// Longest-common-subsequence line diff. O(n·m) space, fine for edit snippets.
func lcsDiffOps(_ a: [String], _ b: [String]) -> [LineDiffOp] {
  let n = a.count, m = b.count
  var dp = Array(repeating: Array(repeating: 0, count: m + 1), count: n + 1)
  if n > 0, m > 0 {
    for i in stride(from: n - 1, through: 0, by: -1) {
      for j in stride(from: m - 1, through: 0, by: -1) {
        dp[i][j] = a[i] == b[j] ? dp[i + 1][j + 1] + 1 : max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }
  var ops: [LineDiffOp] = []
  var i = 0, j = 0
  while i < n, j < m {
    if a[i] == b[j] {
      ops.append(.context(a[i])); i += 1; j += 1
    } else if dp[i + 1][j] >= dp[i][j + 1] {
      ops.append(.remove(a[i])); i += 1
    } else {
      ops.append(.add(b[j])); j += 1
    }
  }
  while i < n { ops.append(.remove(a[i])); i += 1 }
  while j < m { ops.append(.add(b[j])); j += 1 }
  return ops
}
