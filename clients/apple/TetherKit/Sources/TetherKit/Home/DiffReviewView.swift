#if canImport(UIKit)
import SwiftUI

/// A patch, read as code rather than as git output: one band per file, a line
/// rail down the side, and the change carried by a coloured edge instead of a
/// leading `+`/`-` — on a phone that character costs a column of code.
struct DiffReviewView: View {
  let files: [DiffFile]
  @State private var collapsed: Set<String> = []

  var body: some View {
    LazyVStack(alignment: .leading, spacing: 10, pinnedViews: [.sectionHeaders]) {
      ForEach(files) { file in
        Section {
          if !collapsed.contains(file.id) {
            ScrollView(.horizontal, showsIndicators: false) {
              VStack(alignment: .leading, spacing: 0) {
                ForEach(file.rows) { row in DiffRowView(row: row) }
              }
              .padding(.vertical, 4)
            }
          }
        } header: {
          if !file.isPreamble { fileHeader(file) }
        }
      }
    }
  }

  private func fileHeader(_ file: DiffFile) -> some View {
    Button {
      withAnimation(.snappy(duration: 0.2)) {
        if collapsed.contains(file.id) { collapsed.remove(file.id) } else { collapsed.insert(file.id) }
      }
    } label: {
      HStack(spacing: 8) {
        Image(systemName: collapsed.contains(file.id) ? "chevron.right" : "chevron.down")
          .font(.caption2.weight(.semibold)).foregroundStyle(TetherColors.textFaint)
          .frame(width: 10)
        Text(file.path)
          .font(.caption.monospaced()).foregroundStyle(TetherColors.textPrimary)
          .lineLimit(1).truncationMode(.head)
        Spacer(minLength: 8)
        if file.added > 0 {
          Text("+\(file.added)").font(.caption2.monospaced()).foregroundStyle(TetherColors.success)
        }
        if file.removed > 0 {
          Text("−\(file.removed)").font(.caption2.monospaced()).foregroundStyle(TetherColors.danger)
        }
      }
      .padding(.horizontal, 12).padding(.vertical, 9)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(TetherColors.surfaceRaised)
      .overlay(alignment: .bottom) { Rectangle().fill(TetherColors.border).frame(height: 0.5) }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(file.path), \(file.added) added, \(file.removed) removed")
    .accessibilityHint(collapsed.contains(file.id) ? "Expands this file" : "Collapses this file")
  }
}

private struct DiffRowView: View {
  let row: DiffRow

  var body: some View {
    switch row.kind {
    case .hunk:
      Text(row.text.isEmpty ? "⋯" : row.text)
        .font(.caption2.monospaced()).foregroundStyle(TetherColors.accent)
        .padding(.horizontal, 12).padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TetherColors.accent.opacity(0.07))
    case .plain:
      Text(row.text.isEmpty ? " " : row.text)
        .font(.caption2.monospaced()).foregroundStyle(TetherColors.textSecondary)
        .padding(.horizontal, 12).padding(.vertical, 1)
    default:
      HStack(spacing: 0) {
        Text(number)
          .font(.caption2.monospaced()).foregroundStyle(TetherColors.textFaint)
          .frame(width: 34, alignment: .trailing)
          .padding(.trailing, 8)
        Rectangle().fill(edge).frame(width: 2)
        Text(row.text.isEmpty ? " " : row.text)
          .font(.caption.monospaced()).foregroundStyle(TetherColors.textPrimary)
          .textSelection(.enabled)
          .padding(.leading, 8).padding(.vertical, 1)
      }
      .background(tint)
    }
  }

  private var number: String {
    if let newLine = row.newLine { return "\(newLine)" }
    if let oldLine = row.oldLine { return "\(oldLine)" }
    return ""
  }

  private var edge: Color {
    switch row.kind {
    case .added: TetherColors.success
    case .removed: TetherColors.danger
    default: .clear
    }
  }

  private var tint: Color { edge.opacity(0.10) }
}

struct MarkdownBodyView: View {
  let blocks: [MarkdownBlock]
  let inlineBlocks: [[AttributedString]]

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
        switch block {
        case let .heading(level, _):
          Text(inlineBlocks[index][0])
            .font(level == 1 ? .headline : level == 2 ? .subheadline.weight(.semibold) : .footnote.weight(.semibold))
            .foregroundStyle(TetherColors.textPrimary)
            .padding(.top, 2)
        case .paragraph:
          Text(inlineBlocks[index][0]).font(.footnote).foregroundStyle(TetherColors.textSecondary)
        case let .bullets(items):
          listRows(items.map { _ in "•" }, inline: inlineBlocks[index])
        case let .numbered(items):
          listRows(items.enumerated().map { "\($0.offset + 1)." }, inline: inlineBlocks[index])
        case let .code(lines):
          ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 1) {
              ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                Text(line.isEmpty ? " " : line).font(.caption2.monospaced())
                  .foregroundStyle(TetherColors.textPrimary)
              }
            }
            .padding(10)
          }
          .background(TetherColors.input, in: RoundedRectangle(cornerRadius: 8))
        case .quote:
          HStack(spacing: 8) {
            Rectangle().fill(TetherColors.border).frame(width: 2)
            Text(inlineBlocks[index][0]).font(.footnote.italic()).foregroundStyle(TetherColors.textFaint)
          }
        case .rule:
          Rectangle().fill(TetherColors.border).frame(height: 0.5).padding(.vertical, 2)
        }
      }
    }
  }

  private func listRows(_ markers: [String], inline: [AttributedString]) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      ForEach(Array(markers.enumerated()), id: \.offset) { index, marker in
        HStack(alignment: .firstTextBaseline, spacing: 7) {
          Text(marker).font(.caption2.monospaced()).foregroundStyle(TetherColors.textFaint)
          Text(inline[index]).font(.footnote).foregroundStyle(TetherColors.textSecondary)
        }
      }
    }
  }

  static func renderedInline(for blocks: [MarkdownBlock]) -> [[AttributedString]] {
    blocks.map { block in
      switch block {
      case let .heading(_, text), let .paragraph(text), let .quote(text):
        [inline(text)]
      case let .bullets(items), let .numbered(items):
        items.map { inline($0) }
      case .code, .rule:
        []
      }
    }
  }

  private static func inline(_ text: String) -> AttributedString {
    (try? AttributedString(markdown: text)) ?? AttributedString(text)
  }
}
#endif
