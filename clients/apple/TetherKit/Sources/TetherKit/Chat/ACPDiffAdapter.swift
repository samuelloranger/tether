import Foundation

/// Turns an agent's before/after text into the `DiffFile` the Git screens already render.
enum ACPDiffAdapter {
  static let contextLines = 3

  static func file(for diff: ACPDiff, relativeTo cwd: String) -> DiffFile {
    let old = lines(diff.oldText)
    let new = lines(diff.newText)
    let path = ChatFormat.relativePath(diff.path, to: cwd)

    var removedAt = Set<Int>()
    var insertedAt = Set<Int>()
    for change in new.difference(from: old) {
      switch change {
      case let .remove(offset, _, _): removedAt.insert(offset)
      case let .insert(offset, _, _): insertedAt.insert(offset)
      }
    }

    struct Line { var kind: DiffRow.Kind; var old: Int?; var new: Int?; var text: String }
    var all: [Line] = []
    var i = 0
    var j = 0
    while i < old.count || j < new.count {
      if i < old.count, removedAt.contains(i) {
        all.append(Line(kind: .removed, old: i + 1, new: nil, text: old[i]))
        i += 1
      } else if j < new.count, insertedAt.contains(j) {
        all.append(Line(kind: .added, old: nil, new: j + 1, text: new[j]))
        j += 1
      } else if i < old.count, j < new.count {
        all.append(Line(kind: .context, old: i + 1, new: j + 1, text: old[i]))
        i += 1
        j += 1
      } else {
        break
      }
    }

    let added = all.filter { $0.kind == .added }.count
    let removed = all.filter { $0.kind == .removed }.count
    guard added + removed > 0 else {
      let note = DiffRow(id: 0, kind: .plain, oldLine: nil, newLine: nil, text: "No changes")
      return DiffFile(path: path, added: 0, removed: 0, rows: [note])
    }

    let changed = all.indices.filter { all[$0].kind != .context }
    var keep = Array(repeating: false, count: all.count)
    for index in changed {
      for near in max(0, index - contextLines)...min(all.count - 1, index + contextLines) { keep[near] = true }
    }

    var rows: [DiffRow] = []
    var skipping = false
    for (index, line) in all.enumerated() {
      guard keep[index] else {
        skipping = true
        continue
      }
      if skipping {
        rows.append(DiffRow(id: rows.count, kind: .hunk, oldLine: nil, newLine: nil, text: ""))
        skipping = false
      }
      rows.append(DiffRow(id: rows.count, kind: line.kind, oldLine: line.old, newLine: line.new, text: line.text))
    }
    return DiffFile(path: path, added: added, removed: removed, rows: rows)
  }

  private static func lines(_ text: String?) -> [String] {
    guard let text else { return [] }
    var parts = text.components(separatedBy: "\n")
    if parts.last == "" { parts.removeLast() }
    return parts
  }
}
