import SwiftUI

public struct GitReviewView: View {
  @Bindable public var store: SessionStore
  public var path: String
  public var mode: GitDiffMode
  public var onChanged: () -> Void

  @State private var lines: [DiffLine] = []
  @State private var hunkIndices: [Int?] = []
  @State private var truncated = false
  @State private var loading = true
  @State private var loadError: String?

  public init(
    store: SessionStore,
    path: String,
    mode: GitDiffMode,
    onChanged: @escaping () -> Void = {}
  ) {
    self.store = store
    self.path = path
    self.mode = mode
    self.onChanged = onChanged
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
      } else if lines.isEmpty {
        Text("Empty diff")
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
      ToolbarItemGroup(placement: .bottomBar) {
        if mode == .staged {
          Button("Unstage") {
            Task {
              await store.gitUnstage(path: path)
              onChanged()
              await load()
            }
          }
        } else {
          Button("Stage") {
            Task {
              await store.gitStage(path: path)
              onChanged()
              await load()
            }
          }
          Button("Discard", role: .destructive) {
            Task {
              await store.gitDiscard(path: path)
              onChanged()
              await load()
            }
          }
        }
      }
    }
    .task { await load() }
  }

  private var diffScroll: some View {
    ScrollView([.vertical, .horizontal]) {
      LazyVStack(alignment: .leading, spacing: 0) {
        if truncated {
          Text("[Diff truncated at 1 MiB]")
            .font(.caption.monospaced())
            .foregroundStyle(TetherColors.textSecondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
        ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
          DiffLineRow(
            line: line,
            hunkIndex: index < hunkIndices.count ? hunkIndices[index] : nil,
            mode: mode,
            onToggleHunk: { hunk in
              Task { await toggleHunk(hunk) }
            }
          )
        }
      }
      .padding(.vertical, 8)
    }
  }

  private func load() async {
    loading = true
    loadError = nil
    defer { loading = false }
    guard let response = await store.loadFileDiff(path: path, mode: mode) else {
      loadError = store.errorMessage ?? "Failed to load diff"
      return
    }
    let text = displayDiff(response.diff, truncated: response.truncated)
    truncated = response.truncated
    lines = parseDiffLines(text)
    hunkIndices = annotateHunkIndices(lines)
  }

  private func toggleHunk(_ hunkIndex: Int) async {
    if mode == .staged {
      await store.gitUnstageHunk(path: path, hunkIndex: hunkIndex)
    } else {
      await store.gitStageHunk(path: path, hunkIndex: hunkIndex)
    }
    onChanged()
    await load()
  }
}

private struct DiffLineRow: View {
  let line: DiffLine
  let hunkIndex: Int?
  let mode: GitDiffMode
  let onToggleHunk: (Int) -> Void

  var body: some View {
    if line.kind == .meta && line.text.hasPrefix("@@"), let hunkIndex {
      HStack(spacing: 8) {
        Text(line.text)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(TetherColors.textSecondary)
          .lineLimit(1)
        Spacer(minLength: 8)
        Button(mode == .staged ? "Unstage" : "Stage") {
          onToggleHunk(hunkIndex)
        }
        .font(.caption.weight(.semibold))
        .tint(TetherColors.accent)
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
        Text(line.content.isEmpty ? " " : line.content)
          .foregroundStyle(TetherColors.textPrimary)
      }
      .font(.system(.caption, design: .monospaced))
      .padding(.horizontal, 8)
      .padding(.vertical, 1)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(rowBackground)
    }
  }

  private func gutter(_ n: Int?) -> String {
    guard let n else { return "" }
    return String(n)
  }

  private var marker: String {
    switch line.kind {
    case .add: "+"
    case .remove: "-"
    case .context: " "
    case .meta: " "
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
