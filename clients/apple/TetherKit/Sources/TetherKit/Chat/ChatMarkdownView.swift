import SwiftUI
import UIKit

/// Keep selection continuous through prose, while tables retain their cell boundaries.
struct ChatMarkdownView: View {
  let blocks: [MarkdownBlock]
  var reading = true
  var selectable = true
  var message: String?

  static func groups(_ blocks: [MarkdownBlock]) -> [[MarkdownBlock]] {
    var groups: [[MarkdownBlock]] = []
    var prose: [MarkdownBlock] = []
    for block in blocks {
      if case .table = block {
        if !prose.isEmpty { groups.append(prose); prose = [] }
        groups.append([block])
      } else {
        prose.append(block)
      }
    }
    if !prose.isEmpty { groups.append(prose) }
    return groups
  }

  var body: some View {
    VStack(alignment: .leading, spacing: reading ? 9 : 6) {
      ForEach(Array(Self.groups(blocks).enumerated()), id: \.offset) { _, group in
        if case let .table(header, rows)? = group.first {
          ChatMarkdownTable(header: header, rows: rows, reading: reading, selectable: selectable, message: message)
        } else {
          ChatSelectableText(blocks: group, reading: reading, selectable: selectable, message: message)
        }
      }
    }
  }
}

struct ChatMarkdownTable: View {
  let header: [AttributedString]
  let rows: [[AttributedString]]
  var reading = true
  var selectable = true
  var message: String?
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  /// A shared width per column keeps short versions compact and long descriptions readable.
  static func columnWidths(header: [AttributedString], rows: [[AttributedString]], font: UIFont) -> [CGFloat] {
    let cells = [header] + rows
    let scale = font.pointSize / 15
    return (0..<(cells.map(\.count).max() ?? 0)).map { column in
      let natural = cells.map { row -> CGFloat in
        guard column < row.count else { return 0 }
        return (String(row[column].characters) as NSString).size(withAttributes: [.font: font.withTableHeaderWeight]).width
      }.max() ?? 0
      return min(240 * scale, max(80 * scale, ceil(natural)))
    }
  }

  var body: some View {
    let font = UIFont.preferredFont(forTextStyle: reading ? .subheadline : .footnote)
    let widths = Self.columnWidths(header: header, rows: rows, font: font)
    ScrollView(.horizontal) {
      Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
        tableRow(header, widths: widths, isHeader: true)
          .background(TetherColors.surfaceRaised)
        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
          Rectangle().fill(TetherColors.border).frame(height: 0.5)
            .gridCellUnsizedAxes(.horizontal)
          tableRow(row, widths: widths, isHeader: false)
        }
      }
      .padding(.bottom, 4)
    }
    .background(TetherColors.input, in: RoundedRectangle(cornerRadius: 8))
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(TetherColors.border, lineWidth: 0.5))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Table")
    .accessibilityHint("Scroll horizontally to see more columns")
  }

  private func tableRow(_ cells: [AttributedString], widths: [CGFloat], isHeader: Bool) -> some View {
    GridRow(alignment: .top) {
      ForEach(Array(widths.enumerated()), id: \.offset) { column, width in
        let text = column < cells.count ? cells[column] : AttributedString()
        ChatSelectableText(blocks: [.paragraph(isHeader ? Self.emphasized(text) : text)],
          reading: reading, selectable: selectable, message: message)
          .frame(width: width, alignment: .topLeading)
          .padding(.horizontal, 10).padding(.vertical, 8)
          .accessibilityAddTraits(isHeader ? .isHeader : [])
      }
    }
  }

  private static func emphasized(_ text: AttributedString) -> AttributedString {
    var result = text
    for run in result.runs {
      result[run.range].inlinePresentationIntent = (run.inlinePresentationIntent ?? []).union(.stronglyEmphasized)
    }
    return result
  }
}

private extension UIFont {
  var withTableHeaderWeight: UIFont {
    guard let descriptor = fontDescriptor.withSymbolicTraits(.traitBold) else { return self }
    return UIFont(descriptor: descriptor, size: pointSize)
  }
}
