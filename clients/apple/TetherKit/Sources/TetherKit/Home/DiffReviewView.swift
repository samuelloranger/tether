import SwiftUI

/// A patch read as code: one band per file, a line rail, and a coloured edge instead of a
/// leading `+`/`-`, which costs a column of code on a phone.
struct DiffReviewView: View {
  let files: [DiffFile]
  var truncated = false
  var untracked: [String] = []
  var untrackedTruncated = false
  var loadUntracked: ((String) async -> GitPatch?)?

  /// A file this long starts folded, and opens a page at a time: every row is a view, and a
  /// lockfile's worth of them at once stalls the scroll.
  static let pageSize = 400

  /// Small files the user folded, and long files the user opened.
  @State private var toggled: Set<String> = []
  @State private var shownRows: [String: Int] = [:]
  @State private var untrackedPatches: [String: GitPatch] = [:]
  @State private var untrackedFailed: Set<String> = []
  @State private var viewportWidth: CGFloat = 0
  @State private var showCopied = false

  var body: some View {
    LazyVStack(alignment: .leading, spacing: 10, pinnedViews: [.sectionHeaders]) {
      ForEach(files) { file in
        Section {
          if isOpen(file) {
            rows(of: file)
          } else if file.rows.count > Self.pageSize {
            pageButton("Show \(file.rows.count) lines") { toggled.insert(file.id) }
          }
        } header: {
          if !file.isPreamble { fileHeader(file) }
        }
      }
      ForEach(untracked, id: \.self) { path in
        Section {
          if toggled.contains(untrackedKey(path)) { untrackedRows(path) }
        } header: {
          untrackedHeader(path)
        }
      }
      if truncated { notice("The patch is over 2 MB; the rest is not shown.") }
      if untrackedTruncated { notice("More untracked files than are listed here.") }
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { viewportWidth = $0 }
    .copyConfirmation(isPresented: $showCopied)
  }

  private func isOpen(_ file: DiffFile) -> Bool {
    // A short file is open until folded; a long one is folded until opened.
    let long = file.rows.count > Self.pageSize
    return toggled.contains(file.id) == long
  }

  private func rows(of file: DiffFile) -> some View {
    let limit = shownRows[file.id] ?? Self.pageSize
    return VStack(alignment: .leading, spacing: 0) {
      ScrollView(.horizontal, showsIndicators: false) {
        // Sized to the widest row (and at least the screen), so every band spans the same width.
        VStack(alignment: .leading, spacing: 0) {
          ForEach(file.rows.prefix(limit)) { row in
            DiffRowView(row: row, digits: file.lineDigits, minWidth: viewportWidth)
              .contextMenu {
                if row.kind == .hunk {
                  Button { copy(file.hunkPatch(startingAt: row.id)) } label: {
                    Label("Copy hunk", systemImage: "doc.on.doc")
                  }
                }
                Button { copy(file.patchText) } label: { Label("Copy file", systemImage: "doc.on.doc") }
              }
          }
        }
        .fixedSize(horizontal: true, vertical: false)
        .padding(.vertical, 4)
      }
      if file.rows.count > limit {
        pageButton("Show \(min(Self.pageSize, file.rows.count - limit)) more lines") {
          shownRows[file.id] = limit + Self.pageSize
        }
      }
    }
  }

  private func fileHeader(_ file: DiffFile) -> some View {
    Button {
      withAnimation(.snappy(duration: 0.2)) { toggle(file.id) }
    } label: {
      headerLabel(path: file.path, open: isOpen(file)) {
        if file.added > 0 {
          Text("+\(file.added)").font(.caption2.monospaced()).foregroundStyle(TetherColors.success)
        }
        if file.removed > 0 {
          Text("−\(file.removed)").font(.caption2.monospaced()).foregroundStyle(TetherColors.danger)
        }
      }
    }
    .buttonStyle(.plain)
    .contextMenu {
      Button { copy(file.patchText) } label: { Label("Copy file", systemImage: "doc.on.doc") }
    }
    .accessibilityLabel("\(file.path), \(file.added) added, \(file.removed) removed")
    .accessibilityHint(isOpen(file) ? "Collapses this file" : "Expands this file")
  }

  private func untrackedKey(_ path: String) -> String { "untracked:\(path)" }

  private func untrackedHeader(_ path: String) -> some View {
    let open = toggled.contains(untrackedKey(path))
    return Button {
      withAnimation(.snappy(duration: 0.2)) { toggle(untrackedKey(path)) }
    } label: {
      headerLabel(path: path, open: open) {
        Text("NEW").font(.caption2.weight(.bold)).foregroundStyle(TetherColors.success)
          .padding(.horizontal, 6).padding(.vertical, 2)
          .background(TetherColors.success.opacity(0.15), in: Capsule())
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(path), untracked")
    .accessibilityHint(open ? "Collapses this file" : "Shows its contents")
  }

  @ViewBuilder
  private func untrackedRows(_ path: String) -> some View {
    if let patch = untrackedPatches[path] {
      if let file = patch.files.first {
        rows(of: file)
        if patch.truncated { notice("Over 2 MB; the rest is not shown.") }
      } else {
        notice("Nothing to show for this file.")
      }
    } else if untrackedFailed.contains(path) {
      pageButton("Couldn't load this file — try again") { untrackedFailed.remove(path) }
    } else {
      ProgressView().tint(TetherColors.accent).frame(maxWidth: .infinity).padding(.vertical, 10)
        .task {
          guard let loadUntracked else { return }
          if let patch = await loadUntracked(path) {
            untrackedPatches[path] = patch
          } else {
            untrackedFailed.insert(path)
          }
        }
    }
  }

  private func headerLabel(path: String, open: Bool, @ViewBuilder trailing: () -> some View) -> some View {
    HStack(spacing: 8) {
      Image(systemName: open ? "chevron.down" : "chevron.right")
        .font(.caption2.weight(.semibold)).foregroundStyle(TetherColors.textFaint)
        .frame(width: 10)
      Text(path)
        .font(.caption.monospaced()).foregroundStyle(TetherColors.textPrimary)
        .lineLimit(1).truncationMode(.head)
      Spacer(minLength: 8)
      trailing()
    }
    .padding(.horizontal, 12).padding(.vertical, 9)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(TetherColors.surfaceRaised)
    .overlay(alignment: .bottom) { Rectangle().fill(TetherColors.border).frame(height: 0.5) }
    .contentShape(Rectangle())
  }

  private func pageButton(_ title: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(title).font(.caption.weight(.semibold)).foregroundStyle(TetherColors.accent)
        .frame(maxWidth: .infinity).padding(.vertical, 10)
    }
    .buttonStyle(.plain)
  }

  private func notice(_ text: String) -> some View {
    Text(text).font(.caption.monospaced()).foregroundStyle(TetherColors.textFaint)
      .padding(.horizontal, 12).padding(.vertical, 6)
  }

  private func toggle(_ key: String) {
    if toggled.contains(key) { toggled.remove(key) } else { toggled.insert(key) }
  }

  private func copy(_ text: String) {
    acknowledgeCopy(text, into: $showCopied)
  }
}

private struct DiffRowView: View {
  let row: DiffRow
  let digits: Int
  let minWidth: CGFloat

  var body: some View {
    content.frame(minWidth: minWidth, maxWidth: .infinity, alignment: .leading)
      .background(tint)
  }

  @ViewBuilder
  private var content: some View {
    switch row.kind {
    case .hunk:
      Text(row.text.isEmpty ? "⋯" : row.text)
        .font(.caption2.monospaced()).foregroundStyle(TetherColors.accent)
        .padding(.horizontal, 12).padding(.vertical, 5)
    case .plain:
      Text(row.text.isEmpty ? " " : row.text)
        .font(.caption2.monospaced()).foregroundStyle(TetherColors.textSecondary)
        .padding(.horizontal, 12).padding(.vertical, 1)
    default:
      HStack(alignment: .firstTextBaseline, spacing: 0) {
        // A template of the widest number reserves the gutter, so it scales with the text.
        Text(String(repeating: "0", count: digits)).hidden()
          .overlay(alignment: .trailing) { Text(number) }
          .font(.caption2.monospaced()).foregroundStyle(TetherColors.textFaint)
          .padding(.leading, 6).padding(.trailing, 8)
        Text(row.text.isEmpty ? " " : row.text)
          .font(.caption.monospaced()).foregroundStyle(TetherColors.textPrimary)
          .padding(.leading, 8).padding(.trailing, 12).padding(.vertical, 1)
          .overlay(alignment: .leading) { Rectangle().fill(edge).frame(width: 2) }
      }
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

  private var tint: Color {
    switch row.kind {
    case .hunk: TetherColors.accent.opacity(0.07)
    default: edge.opacity(0.10)
    }
  }
}

struct MarkdownBodyView: View {
  let blocks: [MarkdownBlock]

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        switch block {
        case let .heading(level, text):
          Text(text)
            .font(level == 1 ? .headline : level == 2 ? .subheadline.weight(.semibold) : .footnote.weight(.semibold))
            .foregroundStyle(TetherColors.textPrimary)
            .padding(.top, 2)
        case let .paragraph(text):
          Text(text).font(.footnote).foregroundStyle(TetherColors.textSecondary)
        case let .list(items):
          listRows(items)
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
        case let .quote(text):
          Text(text).font(.footnote.italic()).foregroundStyle(TetherColors.textFaint)
            .quoteBar()
        case let .table(header, rows):
          table(header: header, rows: rows)
        case .rule:
          Rectangle().fill(TetherColors.border).frame(height: 0.5).padding(.vertical, 2)
        }
      }
    }
  }

  private func listRows(_ items: [MarkdownListItem]) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      ForEach(Array(items.enumerated()), id: \.offset) { _, item in
        let row = HStack(alignment: .firstTextBaseline, spacing: 7) {
          marker(item.marker).frame(minWidth: 12, alignment: .leading)
          Text(item.text).font(item.quoted ? .footnote.italic() : .footnote)
            .foregroundStyle(item.quoted ? TetherColors.textFaint : TetherColors.textSecondary)
        }
        .padding(.leading, CGFloat(item.depth) * 16)
        if item.quoted { row.quoteBar() } else { row }
      }
    }
  }

  @ViewBuilder
  private func marker(_ marker: MarkdownListItem.Marker) -> some View {
    switch marker {
    case .bullet:
      Text("•").font(.caption2.monospaced()).foregroundStyle(TetherColors.textFaint)
    case let .number(n):
      Text("\(n).").font(.caption2.monospaced()).foregroundStyle(TetherColors.textFaint)
    case let .task(done):
      Image(systemName: done ? "checkmark.square.fill" : "square")
        .font(.caption)
        .foregroundStyle(done ? TetherColors.success : TetherColors.textFaint)
        .accessibilityLabel(done ? "Done" : "To do")
    case .continuation:
      Text(" ").font(.caption2.monospaced())
    }
  }

  private func table(header: [AttributedString], rows: [[AttributedString]]) -> some View {
    ScrollView(.horizontal, showsIndicators: false) {
      Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
        GridRow {
          ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
            Text(cell).font(.caption.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
          }
        }
        Rectangle().fill(TetherColors.border).frame(height: 0.5).gridCellUnsizedAxes(.horizontal)
        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
          GridRow {
            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
              Text(cell).font(.caption).foregroundStyle(TetherColors.textSecondary)
            }
          }
        }
      }
      .padding(10)
    }
    .background(TetherColors.input, in: RoundedRectangle(cornerRadius: 8))
  }
}

private extension View {
  /// The bar takes the text's height; left flexible it stretches to whatever is offered.
  func quoteBar() -> some View {
    padding(.leading, 10)
      .overlay(alignment: .leading) { Rectangle().fill(TetherColors.border).frame(width: 2) }
      .fixedSize(horizontal: false, vertical: true)
  }
}
