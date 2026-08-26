import SwiftUI

/// Port of `apps/mobile/src/SideBySideDiff.tsx`.
public struct SideBySideDiffView: View {
  public var lines: [DiffLine]
  public var path: String

  private let hunkContextRegex = try! NSRegularExpression(
    pattern: #"^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$"#)

  public init(lines: [DiffLine], path: String) {
    self.lines = lines
    self.path = path
  }

  public var body: some View {
    let language = languageForPath(path)
    let rows = pairDiffRows(lines)
    LazyVStack(alignment: .leading, spacing: 0) {
      ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
        if row.span {
          hunkRow(row.left)
        } else {
          HStack(alignment: .top, spacing: 0) {
            cell(row.left, side: .left, language: language)
            Rectangle()
              .fill(TetherColors.surface)
              .frame(width: 1)
            cell(row.right, side: .right, language: language)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private enum Side { case left, right }

  private func cell(_ line: DiffLine?, side: Side, language: CodeLanguage?) -> some View {
    let bg: Color = {
      switch line?.kind {
      case .remove: return TetherColors.danger.opacity(0.14)
      case .add: return Color.green.opacity(0.12)
      default: return Color.clear
      }
    }()
    let number: Int? = side == .left ? line?.oldLine : line?.newLine
    return HStack(alignment: .firstTextBaseline, spacing: 0) {
      Text(number.map(String.init) ?? "")
        .frame(width: 36, alignment: .trailing)
        .foregroundStyle(TetherColors.textSecondary)
      if let line {
        HighlightedCodeText(content: line.content.isEmpty ? " " : line.content, language: language)
          .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        Text(" ")
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .font(.system(.caption, design: .monospaced))
    .padding(.horizontal, 6)
    .padding(.vertical, 1)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(bg)
  }

  private func hunkRow(_ line: DiffLine?) -> some View {
    let context: String = {
      guard let text = line?.text else { return "" }
      let range = NSRange(text.startIndex..<text.endIndex, in: text)
      guard let match = hunkContextRegex.firstMatch(in: text, range: range),
            match.numberOfRanges >= 2,
            let r = Range(match.range(at: 1), in: text)
      else { return "" }
      return String(text[r])
    }()
    return HStack(spacing: 8) {
      Text("⋯")
      if !context.isEmpty {
        Text(context)
          .lineLimit(1)
      }
    }
    .font(.system(.caption, design: .monospaced))
    .foregroundStyle(TetherColors.textSecondary)
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(TetherColors.surface)
  }
}
