import SwiftUI

public struct GitReviewView: View {
  @Bindable public var store: SessionStore
  public var path: String
  public var mode: GitDiffMode
  public var binary: Bool
  public var onChanged: () -> Void

  @Environment(\.dismiss) private var dismiss

  @State private var lines: [DiffLine] = []
  @State private var hunkIndices: [Int?] = []
  @State private var truncated = false
  @State private var loading = true
  @State private var loadError: String?
  @State private var sideBySide = false
  @State private var imageOld: Data?
  @State private var imageNew: Data?
  @State private var imageLoading = false
  @State private var pendingDiscard = false

  public init(
    store: SessionStore,
    path: String,
    mode: GitDiffMode,
    binary: Bool = false,
    onChanged: @escaping () -> Void = {}
  ) {
    self.store = store
    self.path = path
    self.mode = mode
    self.binary = binary
    self.onChanged = onChanged
  }

  private var isImage: Bool { binary && isImagePath(path) }

  /// True when there is at least one add/remove line or a hunk header to show.
  private var hasDiffContent: Bool {
    lines.contains {
      $0.kind == .add || $0.kind == .remove
        || ($0.kind == .meta && $0.text.hasPrefix("@@"))
    }
  }

  public var body: some View {
    Group {
      if loading {
        ProgressView()
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .tint(TetherColors.accent)
      } else if let loadError {
        VStack(spacing: 12) {
          Text(loadError)
            .foregroundStyle(TetherColors.textPrimary)
            .multilineTextAlignment(.center)
          Button("Retry") { Task { await load() } }
            .tint(TetherColors.accent)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if isImage {
        ImageDiffView(oldData: imageOld, newData: imageNew, loading: imageLoading)
      } else if binary {
        Text("Binary file")
          .foregroundStyle(TetherColors.textSecondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if !hasDiffContent {
        Text("No changes")
          .foregroundStyle(TetherColors.textSecondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        diffScroll
      }
    }
    .background(TetherColors.background)
    .navigationTitle(path)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if !binary && hasDiffContent {
        ToolbarItem(placement: .topBarTrailing) {
          Button(sideBySide ? "Unified" : "Side by side") {
            sideBySide.toggle()
          }
          .tint(TetherColors.accent)
        }
      }
      ToolbarItemGroup(placement: .bottomBar) {
        if mode == .staged {
          Button("Unstage") {
            Task {
              await store.gitUnstage(path: path)
              onChanged()
              await load(popIfEmpty: true)
            }
          }
        } else {
          Button("Stage") {
            Task {
              await store.gitStage(path: path)
              onChanged()
              await load(popIfEmpty: true)
            }
          }
          Button("Discard", role: .destructive) {
            pendingDiscard = true
          }
        }
      }
    }
    .confirmationDialog(
      "Discard changes to \(path)?",
      isPresented: $pendingDiscard,
      titleVisibility: .visible
    ) {
      Button("Discard", role: .destructive) {
        Task {
          await store.gitDiscard(path: path)
          onChanged()
          dismiss()
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This cannot be undone.")
    }
    .task { await load() }
  }

  private var diffScroll: some View {
    GeometryReader { proxy in
      ScrollView(.vertical) {
        VStack(alignment: .leading, spacing: 0) {
          if truncated {
            Text("[Diff truncated at 1 MiB]")
              .font(.caption.monospaced())
              .foregroundStyle(TetherColors.textSecondary)
              .padding(.horizontal, 12)
              .padding(.vertical, 6)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          if sideBySide {
            SideBySideDiffView(lines: lines, path: path)
          } else {
            UnifiedDiffBody(
              lines: lines,
              path: path,
              hunkIndices: hunkIndices,
              mode: mode,
              minWidth: proxy.size.width,
              onToggleHunk: { hunk in
                Task { await toggleHunk(hunk) }
              }
            )
          }
        }
        // Bi-axis ScrollView centres undersized content; pin to top-leading and
        // fill the viewport so short diffs are left-aligned edge-to-edge.
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .padding(.vertical, 8)
      }
    }
  }

  private func load(popIfEmpty: Bool = false) async {
    if isImage {
      await loadImages()
      return
    }
    loading = true
    loadError = nil
    defer { loading = false }
    guard let response = await store.loadFileDiff(path: path, mode: mode) else {
      loadError = store.errorMessage ?? "Failed to load diff"
      return
    }
    truncated = response.truncated
    let parsed = parseDiffLines(response.diff)
    let fullIndices = annotateHunkIndices(parsed)
    let visible = visibleDiffLines(parsed, hunkIndices: fullIndices)
    lines = visible.lines
    hunkIndices = visible.hunkIndices

    let hasContent = visible.lines.contains {
      $0.kind == .add || $0.kind == .remove
        || ($0.kind == .meta && $0.text.hasPrefix("@@"))
    }
    if popIfEmpty && !hasContent && !binary {
      dismiss()
    }
  }

  private func loadImages() async {
    loading = false
    imageLoading = true
    defer { imageLoading = false }
    async let old = store.loadDiffBlob(path: path, side: .old)
    async let new = store.loadDiffBlob(path: path, side: .new)
    imageOld = await old
    imageNew = await new
  }

  private func toggleHunk(_ hunkIndex: Int) async {
    if mode == .staged {
      await store.gitUnstageHunk(path: path, hunkIndex: hunkIndex)
    } else {
      await store.gitStageHunk(path: path, hunkIndex: hunkIndex)
    }
    onChanged()
    await load(popIfEmpty: true)
  }
}

struct UnifiedDiffBody: View {
  var lines: [DiffLine]
  var path: String
  var hunkIndices: [Int?]
  var mode: GitDiffMode?
  var minWidth: CGFloat = 0
  var onToggleHunk: ((Int) -> Void)?

  private var language: CodeLanguage? { languageForPath(path) }

  var body: some View {
    LazyVStack(alignment: .leading, spacing: 0) {
      ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
        DiffLineRow(
          line: line,
          hunkIndex: index < hunkIndices.count ? hunkIndices[index] : nil,
          mode: mode,
          language: language,
          minWidth: minWidth,
          onToggleHunk: onToggleHunk
        )
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct DiffLineRow: View {
  let line: DiffLine
  let hunkIndex: Int?
  let mode: GitDiffMode?
  let language: CodeLanguage?
  var minWidth: CGFloat = 0
  let onToggleHunk: ((Int) -> Void)?

  private let hunkContextRegex = try! NSRegularExpression(
    pattern: #"^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$"#)

  var body: some View {
    if line.kind == .meta && line.text.hasPrefix("@@") {
      HStack(spacing: 8) {
        Text("⋯")
          .foregroundStyle(TetherColors.textSecondary)
        Text(hunkContext)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(TetherColors.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 8)
        if let hunkIndex, let mode, let onToggleHunk {
          Button(mode == .staged ? "Unstage" : "Stage") {
            onToggleHunk(hunkIndex)
          }
          .font(.caption.weight(.semibold))
          .tint(TetherColors.accent)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 6)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(TetherColors.surface)
    } else {
      HStack(alignment: .firstTextBaseline, spacing: 0) {
        Text(gutter(line.oldLine))
          .frame(width: 40, alignment: .trailing)
          .foregroundStyle(TetherColors.textSecondary)
        Text(gutter(line.newLine))
          .frame(width: 40, alignment: .trailing)
          .foregroundStyle(TetherColors.textSecondary)
        Text(marker)
          .frame(width: 14, alignment: .center)
          .foregroundStyle(markerColor)
        HighlightedCodeText(
          content: line.content.isEmpty ? " " : line.content,
          language: language
        )
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .font(.system(.caption, design: .monospaced))
      .padding(.horizontal, 8)
      .padding(.vertical, 1)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(rowBackground)
    }
  }

  private var hunkContext: String {
    let range = NSRange(line.text.startIndex..<line.text.endIndex, in: line.text)
    guard let match = hunkContextRegex.firstMatch(in: line.text, range: range),
          match.numberOfRanges >= 2,
          let r = Range(match.range(at: 1), in: line.text)
    else { return "" }
    return String(line.text[r])
  }

  private func gutter(_ n: Int?) -> String {
    guard let n else { return "" }
    return String(n)
  }

  private var marker: String {
    switch line.kind {
    case .add: "+"
    case .remove: "-"
    case .context, .meta: " "
    }
  }

  private var markerColor: Color {
    switch line.kind {
    case .add: Color.green.opacity(0.9)
    case .remove: TetherColors.danger
    case .context, .meta: TetherColors.textSecondary
    }
  }

  private var rowBackground: Color {
    switch line.kind {
    case .add: Color.green.opacity(0.12)
    case .remove: TetherColors.danger.opacity(0.14)
    case .meta: TetherColors.surface.opacity(0.5)
    case .context: Color.clear
    }
  }
}
